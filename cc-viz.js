#!/usr/bin/env node
// cc-viz.js — Claude Code session transcript visualizer
// Usage: node cc-viz.js <transcript.jsonl> [-o out.html]
// Zero runtime dependencies — Node 23 stdlib only.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

// ──────────────────────────────────────────────
// CLI argument parsing
// ──────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.error('Usage: node cc-viz.js <transcript.jsonl> [-o out.html]');
    process.exit(args.length === 0 ? 1 : 0);
  }
  const inputPath = resolve(args[0]);
  const oIdx = args.indexOf('-o');
  const outputPath = oIdx !== -1 && args[oIdx + 1]
    ? resolve(args[oIdx + 1])
    : resolve(inputPath.replace(/\.jsonl$/, '') + '.html');
  return { inputPath, outputPath };
}

// ──────────────────────────────────────────────
// JSONL parsing — defensive, never throws on bad lines
// ──────────────────────────────────────────────
function parseJsonl(raw) {
  const lines = raw.split('\n');
  const records = [];
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

// ──────────────────────────────────────────────
// Data extraction helpers — never assume field exists
// ──────────────────────────────────────────────
function safeStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function getContentBlocks(record) {
  const msg = record?.message;
  if (!msg) return [];
  const content = msg?.content;
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.filter(b => b && typeof b === 'object');
  }
  return [];
}

function getTokens(record) {
  const usage = record?.message?.usage;
  if (!usage) return null;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

// ──────────────────────────────────────────────
// Aggregate statistics
// ──────────────────────────────────────────────
function buildStats(records) {
  let turns = 0;
  let thinkingBlocks = 0;
  const toolCounts = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let hasTokens = false;
  let firstTs = null;
  let lastTs = null;

  for (const rec of records) {
    const type = rec?.type;
    if (type !== 'user' && type !== 'assistant') continue;
    turns += 1;

    const ts = rec?.timestamp;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    const blocks = getContentBlocks(rec);
    for (const block of blocks) {
      if (block.type === 'thinking') thinkingBlocks += 1;
      if (block.type === 'tool_use') {
        const name = safeStr(block.name || 'unknown');
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      }
    }

    const tok = getTokens(rec);
    if (tok) {
      hasTokens = true;
      totalInput += tok.input;
      totalOutput += tok.output;
      totalCacheRead += tok.cacheRead;
    }
  }

  const durationMs = firstTs && lastTs
    ? new Date(lastTs) - new Date(firstTs)
    : null;

  return {
    turns,
    thinkingBlocks,
    toolCounts,
    totalInput,
    totalOutput,
    totalCacheRead,
    hasTokens,
    firstTs,
    lastTs,
    durationMs,
  };
}

// ──────────────────────────────────────────────
// HTML escaping
// ──────────────────────────────────────────────
function esc(str) {
  return safeStr(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(str) {
  return esc(str).replace(/\n/g, '&#10;');
}

// ──────────────────────────────────────────────
// Truncation for large tool results
// ──────────────────────────────────────────────
const TRUNCATE_CHARS = 2000;

function maybeTruncate(text) {
  const s = safeStr(text);
  if (s.length <= TRUNCATE_CHARS) return { text: s, truncated: false };
  return { text: s.slice(0, TRUNCATE_CHARS), truncated: true, total: s.length };
}

// ──────────────────────────────────────────────
// Block renderers → HTML strings
// ──────────────────────────────────────────────
let blockIdCounter = 0;
function nextId() { return `b${++blockIdCounter}`; }

function renderTextBlock(block) {
  const text = safeStr(block.text ?? block.content ?? '');
  if (!text) return '';
  return `<div class="block block-text" data-type="text">
    <div class="block-body text-content">${esc(text)}</div>
  </div>`;
}

function renderThinkingBlock(block) {
  const thinking = safeStr(block.thinking ?? '');
  const id = nextId();
  const preview = thinking.slice(0, 120).replace(/\n/g, ' ');
  return `<div class="block block-thinking" data-type="thinking">
    <button class="collapsible-btn" onclick="toggleBlock('${id}')" aria-expanded="false">
      <span class="block-label">Thinking</span>
      <span class="preview" id="${id}-preview">${esc(preview)}${thinking.length > 120 ? '…' : ''}</span>
      <span class="chevron">▶</span>
    </button>
    <div class="collapsible-body" id="${id}" hidden>
      <pre class="thinking-text">${esc(thinking)}</pre>
    </div>
  </div>`;
}

function renderToolUseBlock(block) {
  const name = safeStr(block.name ?? 'unknown');
  const input = block.input !== undefined
    ? JSON.stringify(block.input, null, 2)
    : '';
  const id = nextId();
  return `<div class="block block-tool-use" data-type="tool_use" data-tool="${escAttr(name)}">
    <button class="collapsible-btn" onclick="toggleBlock('${id}')" aria-expanded="false">
      <span class="block-label">Tool</span>
      <span class="tool-name">${esc(name)}</span>
      <span class="chevron">▶</span>
    </button>
    <div class="collapsible-body" id="${id}" hidden>
      <pre class="json-input">${esc(input)}</pre>
    </div>
  </div>`;
}

function renderToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') return c;
      if (c?.type === 'text') return safeStr(c.text ?? '');
      return JSON.stringify(c);
    }).join('\n');
  }
  return JSON.stringify(content ?? '');
}

function renderToolResultBlock(block) {
  const rawContent = renderToolResultContent(block.content ?? block.output ?? '');
  const isError = Boolean(block.is_error);
  const { text, truncated, total } = maybeTruncate(rawContent);
  const id = nextId();
  const toolUseId = safeStr(block.tool_use_id ?? '');
  return `<div class="block block-tool-result${isError ? ' block-error' : ''}" data-type="tool_result">
    <button class="collapsible-btn" onclick="toggleBlock('${id}')" aria-expanded="false">
      <span class="block-label">${isError ? 'Tool Error' : 'Tool Result'}</span>
      ${toolUseId ? `<span class="tool-id">${esc(toolUseId.slice(-8))}</span>` : ''}
      <span class="chevron">▶</span>
    </button>
    <div class="collapsible-body" id="${id}" hidden>
      <pre class="result-text">${esc(text)}</pre>
      ${truncated ? `<div class="truncation-note">… truncated (${total.toLocaleString()} chars total)</div>` : ''}
    </div>
  </div>`;
}

function renderUnknownBlock(block) {
  const id = nextId();
  return `<div class="block block-unknown" data-type="unknown">
    <button class="collapsible-btn" onclick="toggleBlock('${id}')" aria-expanded="false">
      <span class="block-label">Unknown block (type: ${esc(block.type ?? '?')})</span>
      <span class="chevron">▶</span>
    </button>
    <div class="collapsible-body" id="${id}" hidden>
      <pre>${esc(JSON.stringify(block, null, 2))}</pre>
    </div>
  </div>`;
}

function renderBlock(block) {
  switch (block.type) {
    case 'text':        return renderTextBlock(block);
    case 'thinking':    return renderThinkingBlock(block);
    case 'tool_use':    return renderToolUseBlock(block);
    case 'tool_result': return renderToolResultBlock(block);
    default:            return renderUnknownBlock(block);
  }
}

// ──────────────────────────────────────────────
// Card renderers
// ──────────────────────────────────────────────
function cardClass(type) {
  switch (type) {
    case 'user':      return 'card-user';
    case 'assistant': return 'card-assistant';
    default:          return 'card-other';
  }
}

function formatTs(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return safeStr(ts);
  }
}

function getCardTypes(blocks) {
  const types = new Set();
  for (const b of blocks) {
    if (b.type === 'text') types.add('text');
    else if (b.type === 'thinking') types.add('thinking');
    else if (b.type === 'tool_use') types.add('tool_use');
    else if (b.type === 'tool_result') types.add('tool_result');
    else types.add('other');
  }
  return [...types].join(' ');
}

function renderRecord(record, idx) {
  const type = safeStr(record?.type);
  if (type !== 'user' && type !== 'assistant') return '';

  const blocks = getContentBlocks(record);
  if (blocks.length === 0) return '';

  const ts = record?.timestamp;
  const tok = getTokens(record);
  const cardTypes = getCardTypes(blocks);

  const blocksHtml = blocks.map(renderBlock).join('');
  if (!blocksHtml.trim()) return '';

  const tokHtml = tok
    ? `<span class="token-info">in:${tok.input} out:${tok.output}${tok.cacheRead ? ` cache:${tok.cacheRead}` : ''}</span>`
    : '';

  return `<article class="card ${cardClass(type)}" data-type="${esc(type)}" data-content-types="${esc(cardTypes)}" data-index="${idx}">
  <header class="card-header">
    <span class="role-badge role-${esc(type)}">${esc(type)}</span>
    ${ts ? `<span class="timestamp">${esc(formatTs(ts))}</span>` : ''}
    ${tokHtml}
  </header>
  <div class="card-body">${blocksHtml}</div>
</article>`;
}

// ──────────────────────────────────────────────
// Stats header HTML
// ──────────────────────────────────────────────
function formatDuration(ms) {
  if (ms === null) return 'unknown';
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function renderStats(stats, skipped) {
  const toolEntries = Object.entries(stats.toolCounts)
    .sort((a, b) => b[1] - a[1]);

  const toolsHtml = toolEntries.length > 0
    ? `<div class="stat-group">
        <span class="stat-label">Tools</span>
        <div class="tool-badges">
          ${toolEntries.map(([name, count]) =>
            `<span class="tool-badge" title="${esc(name)}">${esc(name)}<em>${count}</em></span>`
          ).join('')}
        </div>
      </div>`
    : '';

  const tokensHtml = stats.hasTokens
    ? `<div class="stat-group">
        <span class="stat-label">Tokens</span>
        <span class="stat-value">in: ${stats.totalInput.toLocaleString()} / out: ${stats.totalOutput.toLocaleString()}${stats.totalCacheRead ? ` / cache-read: ${stats.totalCacheRead.toLocaleString()}` : ''}</span>
      </div>`
    : '';

  const skippedHtml = skipped > 0
    ? `<div class="skipped-note">${skipped} line${skipped > 1 ? 's' : ''} skipped (malformed JSON)</div>`
    : '';

  return `<section class="stats-header">
  <h1>Claude Code Session Transcript</h1>
  <div class="stats-grid">
    <div class="stat-group">
      <span class="stat-label">Turns</span>
      <span class="stat-value">${stats.turns}</span>
    </div>
    <div class="stat-group">
      <span class="stat-label">Thinking blocks</span>
      <span class="stat-value">${stats.thinkingBlocks}</span>
    </div>
    ${toolsHtml}
    ${tokensHtml}
    <div class="stat-group">
      <span class="stat-label">Duration</span>
      <span class="stat-value">${formatDuration(stats.durationMs)}</span>
    </div>
    ${stats.firstTs ? `<div class="stat-group">
      <span class="stat-label">Start</span>
      <span class="stat-value">${esc(formatTs(stats.firstTs))}</span>
    </div>` : ''}
    ${stats.lastTs ? `<div class="stat-group">
      <span class="stat-label">End</span>
      <span class="stat-value">${esc(formatTs(stats.lastTs))}</span>
    </div>` : ''}
  </div>
  ${skippedHtml}
</section>`;
}

// ──────────────────────────────────────────────
// Controls bar HTML
// ──────────────────────────────────────────────
function renderControls() {
  return `<div class="controls" id="controls">
  <div class="controls-row">
    <div class="filter-group">
      <span class="filter-label">Show:</span>
      <label><input type="checkbox" data-filter="user" checked> User</label>
      <label><input type="checkbox" data-filter="assistant" checked> Assistant</label>
      <label><input type="checkbox" data-filter="text" checked> Text</label>
      <label><input type="checkbox" data-filter="thinking" checked> Thinking</label>
      <label><input type="checkbox" data-filter="tool_use" checked> Tool Calls</label>
      <label><input type="checkbox" data-filter="tool_result" checked> Tool Results</label>
    </div>
    <div class="action-group">
      <button onclick="expandAll()">Expand All</button>
      <button onclick="collapseAll()">Collapse All</button>
    </div>
  </div>
  <div class="controls-row">
    <input type="search" id="searchBox" placeholder="Search cards…" oninput="applySearch(this.value)" autocomplete="off">
    <span id="searchCount" class="search-count"></span>
  </div>
</div>`;
}

// ──────────────────────────────────────────────
// Inlined CSS
// ──────────────────────────────────────────────
const CSS = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --bg: #0f1117;
  --bg2: #1a1d27;
  --bg3: #22263a;
  --border: #2e3350;
  --text: #e2e5f0;
  --muted: #7b82a0;
  --accent-user: #3b5bdb;
  --accent-asst: #0ca678;
  --accent-think: #ae3ec9;
  --accent-tool: #e67700;
  --accent-result: #1c7ed6;
  --accent-err: #c92a2a;
  --hl: #ffec99;
  --hl-text: #1a1a00;
  --radius: 8px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
}
body { background: var(--bg); color: var(--text); margin: 0; padding: 0; line-height: 1.6; }
a { color: var(--accent-result); }

/* Layout */
.page { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }

/* Stats */
.stats-header { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; margin-bottom: 20px; }
.stats-header h1 { margin: 0 0 16px; font-size: 1.4rem; color: var(--text); }
.stats-grid { display: flex; flex-wrap: wrap; gap: 16px 32px; }
.stat-group { display: flex; flex-direction: column; gap: 4px; }
.stat-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.stat-value { font-size: 0.95rem; font-weight: 600; }
.tool-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.tool-badge { display: inline-flex; align-items: center; gap: 4px; background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 0.8rem; }
.tool-badge em { background: var(--accent-tool); color: #fff; border-radius: 3px; padding: 0 4px; font-style: normal; font-size: 0.75rem; }
.skipped-note { margin-top: 12px; color: var(--accent-err); font-size: 0.85rem; }

/* Controls */
.controls { position: sticky; top: 0; z-index: 10; background: var(--bg); border-bottom: 1px solid var(--border); padding: 10px 0 10px; margin-bottom: 16px; }
.controls-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 6px; }
.controls-row:last-child { margin-bottom: 0; }
.filter-label { color: var(--muted); font-size: 0.85rem; }
.filter-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 0.85rem; }
.filter-group label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.action-group { display: flex; gap: 6px; margin-left: auto; }
.action-group button, .controls button {
  background: var(--bg3); border: 1px solid var(--border); color: var(--text);
  border-radius: 4px; padding: 4px 12px; font-size: 0.82rem; cursor: pointer;
}
.action-group button:hover, .controls button:hover { background: var(--border); }
#searchBox {
  flex: 1; min-width: 200px; max-width: 400px;
  background: var(--bg2); border: 1px solid var(--border); color: var(--text);
  border-radius: 4px; padding: 6px 10px; font-size: 0.9rem;
}
#searchBox:focus { outline: none; border-color: var(--accent-result); }
.search-count { color: var(--muted); font-size: 0.82rem; }

/* Cards */
.card { border-radius: var(--radius); margin-bottom: 12px; border: 1px solid var(--border); overflow: hidden; }
.card[hidden] { display: none !important; }
.card-user   { border-left: 3px solid var(--accent-user); background: var(--bg2); }
.card-assistant { border-left: 3px solid var(--accent-asst); background: var(--bg2); }
.card-other  { border-left: 3px solid var(--muted); background: var(--bg2); }

.card-header { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--bg3); }
.role-badge { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 2px 8px; border-radius: 3px; }
.role-user      { background: var(--accent-user); color: #fff; }
.role-assistant { background: var(--accent-asst); color: #fff; }
.timestamp { color: var(--muted); font-size: 0.78rem; }
.token-info { margin-left: auto; color: var(--muted); font-size: 0.75rem; }

.card-body { padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; }

/* Blocks */
.block { border-radius: 4px; overflow: hidden; }
.block-text .block-body { }
.text-content { white-space: pre-wrap; word-break: break-word; font-size: 0.9rem; margin: 0; }

/* Collapsible blocks */
.collapsible-btn {
  width: 100%; display: flex; align-items: center; gap: 8px;
  background: transparent; border: none; cursor: pointer; text-align: left;
  color: var(--text); padding: 6px 10px; border-radius: 4px;
  font-size: 0.85rem;
}
.block-thinking .collapsible-btn { background: rgba(174,62,201,.12); }
.block-tool-use .collapsible-btn { background: rgba(230,119,0,.12); }
.block-tool-result .collapsible-btn { background: rgba(28,126,214,.12); }
.block-error .collapsible-btn { background: rgba(201,42,42,.12); }
.block-unknown .collapsible-btn { background: rgba(123,130,160,.1); }
.collapsible-btn:hover { filter: brightness(1.15); }

.block-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; padding: 1px 6px; border-radius: 3px; white-space: nowrap; }
.block-thinking .block-label { background: var(--accent-think); color: #fff; }
.block-tool-use .block-label { background: var(--accent-tool); color: #fff; }
.block-tool-result .block-label { background: var(--accent-result); color: #fff; }
.block-error .block-label { background: var(--accent-err); color: #fff; }
.block-unknown .block-label { background: var(--muted); color: var(--bg); }

.tool-name { font-family: monospace; font-size: 0.88rem; font-weight: 600; }
.tool-id { color: var(--muted); font-size: 0.75rem; font-family: monospace; }
.preview { color: var(--muted); font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
.chevron { margin-left: auto; font-size: 0.7rem; transition: transform .15s; }
.collapsible-btn[aria-expanded="true"] .chevron { transform: rotate(90deg); }

.collapsible-body { padding: 0; }
.collapsible-body pre {
  margin: 0; padding: 10px 14px; font-size: 0.8rem; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; overflow-x: auto;
  background: var(--bg); color: var(--text);
}
.thinking-text { color: #c8a0e0; }
.json-input { color: #a0c8e0; }
.result-text { color: #9cc9a0; }
.truncation-note { padding: 6px 14px; font-size: 0.78rem; color: var(--accent-err); background: var(--bg); border-top: 1px solid var(--border); }

/* Search highlight */
mark { background: var(--hl); color: var(--hl-text); border-radius: 2px; padding: 0 1px; }

/* Hidden by filter */
.block[data-hidden-filter] { display: none; }

/* Responsive */
@media (max-width: 600px) {
  .page { padding: 12px 8px 48px; }
  .stats-grid { flex-direction: column; }
}
`;

// ──────────────────────────────────────────────
// Inlined JS (vanilla, no deps)
// ──────────────────────────────────────────────
const JS = `
// Collapse/expand individual blocks
function toggleBlock(id) {
  const body = document.getElementById(id);
  if (!body) return;
  const btn = body.previousElementSibling;
  const isHidden = body.hidden;
  body.hidden = !isHidden;
  if (btn) btn.setAttribute('aria-expanded', String(isHidden));
}

function expandAll() {
  document.querySelectorAll('.collapsible-body').forEach(el => {
    el.hidden = false;
    const btn = el.previousElementSibling;
    if (btn) btn.setAttribute('aria-expanded', 'true');
  });
}

function collapseAll() {
  document.querySelectorAll('.collapsible-body').forEach(el => {
    el.hidden = true;
    const btn = el.previousElementSibling;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}

// ── Filtering ──────────────────────────────────
const activeFilters = {
  user: true, assistant: true,
  text: true, thinking: true, tool_use: true, tool_result: true
};

document.querySelectorAll('[data-filter]').forEach(cb => {
  cb.addEventListener('change', () => {
    const key = cb.dataset.filter;
    activeFilters[key] = cb.checked;
    applyFilters();
  });
});

function applyFilters() {
  document.querySelectorAll('.card').forEach(card => {
    const cardType = card.dataset.type;
    const contentTypes = (card.dataset.contentTypes || '').split(' ');

    // Check card-level role filter
    const roleOk = activeFilters[cardType] !== false;

    // For blocks within the card
    card.querySelectorAll('.block[data-type]').forEach(block => {
      const bt = block.dataset.type || 'other';
      const visible = activeFilters[bt] !== false;
      block.toggleAttribute('data-hidden-filter', !visible);
    });

    // Hide card only if role is filtered out, or ALL its blocks are hidden
    const anyBlockVisible = [...card.querySelectorAll('.block[data-type]')]
      .some(b => !b.hasAttribute('data-hidden-filter'));

    card.hidden = !roleOk || !anyBlockVisible;
  });
  updateSearchCount();
}

// ── Search ─────────────────────────────────────
let currentQuery = '';

function applySearch(query) {
  currentQuery = query.toLowerCase().trim();
  // Remove existing highlights
  document.querySelectorAll('mark[data-search]').forEach(m => {
    m.replaceWith(document.createTextNode(m.textContent));
  });

  if (!currentQuery) {
    document.querySelectorAll('.card').forEach(card => {
      card.removeAttribute('data-search-hidden');
    });
    // Re-normalize text nodes after mark removal
    document.querySelectorAll('.card').forEach(c => c.normalize());
    updateSearchCount();
    return;
  }

  document.querySelectorAll('.card').forEach(c => c.normalize());

  document.querySelectorAll('.card').forEach(card => {
    const text = card.innerText.toLowerCase();
    if (text.includes(currentQuery)) {
      card.removeAttribute('data-search-hidden');
      highlightInNode(card, currentQuery);
    } else {
      card.setAttribute('data-search-hidden', '1');
    }
  });

  // Update visibility respecting both filters and search
  document.querySelectorAll('.card').forEach(card => {
    const searchHidden = card.hasAttribute('data-search-hidden');
    const filterHidden = card.hidden;
    // We manage search separately; rely on 'hidden' for filters only
    // Use a class to stack
    card.classList.toggle('search-hidden', searchHidden);
  });
  updateSearchCount();
}

// Highlight matches in text nodes
function highlightInNode(root, query) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentNode.tagName === 'MARK') return NodeFilter.FILTER_REJECT;
      if (node.parentNode.tagName === 'SCRIPT') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const val = node.nodeValue;
    const lower = val.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx === -1) continue;
    const before = document.createTextNode(val.slice(0, idx));
    const mark = document.createElement('mark');
    mark.dataset.search = '1';
    mark.textContent = val.slice(idx, idx + query.length);
    const after = document.createTextNode(val.slice(idx + query.length));
    node.parentNode.replaceChild(after, node);
    node.parentNode.insertBefore(mark, after);
    node.parentNode.insertBefore(before, mark);
  }
}

// Keep search-hidden cards hidden even when filter passes
const origStyle = document.createElement('style');
origStyle.textContent = '.card.search-hidden { display: none !important; }';
document.head.appendChild(origStyle);

function updateSearchCount() {
  const el = document.getElementById('searchCount');
  if (!el) return;
  const total = document.querySelectorAll('.card').length;
  const visible = [...document.querySelectorAll('.card')]
    .filter(c => !c.hidden && !c.classList.contains('search-hidden')).length;
  el.textContent = currentQuery ? \`\${visible} / \${total} cards\` : '';
}

// Initial filter application
applyFilters();
`;

// ──────────────────────────────────────────────
// Full HTML assembly
// ──────────────────────────────────────────────
function buildHtml(statsHtml, controlsHtml, cardsHtml, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — cc-visualizer</title>
<style>
${CSS}
</style>
</head>
<body>
<div class="page">
${statsHtml}
${controlsHtml}
<div id="timeline">
${cardsHtml}
</div>
</div>
<script>
${JS}
</script>
</body>
</html>`;
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
function main() {
  const { inputPath, outputPath } = parseArgs(process.argv);

  let raw;
  try {
    raw = readFileSync(inputPath, 'utf8');
  } catch (err) {
    console.error(`Error reading file: ${err.message}`);
    process.exit(1);
  }

  const { records, skipped } = parseJsonl(raw);
  if (records.length === 0) {
    console.error('No valid JSON lines found in input file.');
    process.exit(1);
  }

  const stats = buildStats(records);

  const statsHtml = renderStats(stats, skipped);
  const controlsHtml = renderControls();

  const cardsHtml = records
    .map((rec, idx) => {
      try {
        return renderRecord(rec, idx);
      } catch (err) {
        return `<!-- card ${idx} render error: ${esc(err.message)} -->`;
      }
    })
    .join('\n');

  const title = basename(inputPath, '.jsonl');
  const html = buildHtml(statsHtml, controlsHtml, cardsHtml, title);

  try {
    writeFileSync(outputPath, html, 'utf8');
  } catch (err) {
    console.error(`Error writing output: ${err.message}`);
    process.exit(1);
  }

  const bytes = Buffer.byteLength(html, 'utf8');
  console.log(`cc-visualizer: ${records.length} records processed`);
  console.log(`  Turns: ${stats.turns} | Tool calls: ${Object.values(stats.toolCounts).reduce((a,b)=>a+b,0)} | Thinking blocks: ${stats.thinkingBlocks}`);
  if (skipped > 0) console.log(`  Skipped (malformed): ${skipped} lines`);
  console.log(`  Output: ${outputPath} (${(bytes / 1024).toFixed(1)} KB)`);
}

main();
