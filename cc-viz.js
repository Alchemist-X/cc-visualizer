#!/usr/bin/env node
// cc-viz.js — Claude Code session transcript visualizer
// Usage: node cc-viz.js <transcript.jsonl> [-o out.html]
// Zero runtime dependencies — Node stdlib only.

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
// Data extraction helpers
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

function getModel(record) {
  return record?.message?.model ?? null;
}

// ──────────────────────────────────────────────
// Aggregate statistics
// ──────────────────────────────────────────────
function buildStats(records) {
  let userTurns = 0;
  let assistantTurns = 0;
  let thinkingBlocks = 0;
  let thinkingWords = 0;
  const toolCounts = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let hasTokens = false;
  let firstTs = null;
  let lastTs = null;
  const models = new Set();

  for (const rec of records) {
    const type = rec?.type;
    if (type !== 'user' && type !== 'assistant') continue;

    if (type === 'user') userTurns += 1;
    else assistantTurns += 1;

    const ts = rec?.timestamp;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    const model = getModel(rec);
    if (model) models.add(model);

    const blocks = getContentBlocks(rec);
    for (const block of blocks) {
      if (block.type === 'thinking') {
        thinkingBlocks += 1;
        const words = safeStr(block.thinking ?? '').trim().split(/\s+/).filter(Boolean).length;
        thinkingWords += words;
      }
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
      totalCacheWrite += tok.cacheWrite;
    }
  }

  const durationMs = firstTs && lastTs
    ? new Date(lastTs) - new Date(firstTs)
    : null;

  return {
    userTurns,
    assistantTurns,
    turns: userTurns + assistantTurns,
    thinkingBlocks,
    thinkingWords,
    toolCounts,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    hasTokens,
    firstTs,
    lastTs,
    durationMs,
    models: [...models],
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
const TRUNCATE_CHARS = 3000;

function maybeTruncate(text) {
  const s = safeStr(text);
  if (s.length <= TRUNCATE_CHARS) return { text: s, truncated: false };
  return { text: s.slice(0, TRUNCATE_CHARS), truncated: true, total: s.length };
}

// ──────────────────────────────────────────────
// JSON syntax highlighting (vanilla, no deps)
// Returns HTML string with spans for syntax coloring
// ──────────────────────────────────────────────
function syntaxHighlightJson(obj) {
  let json;
  try {
    json = JSON.stringify(obj, null, 2);
  } catch {
    json = safeStr(obj);
  }
  // Escape HTML first, then wrap tokens
  const escaped = esc(json);
  return escaped.replace(
    /(&quot;)((?:[^&]|&amp;|&lt;|&gt;|&#39;)*?)(&quot;)(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, oq, val, cq, colon, kw, num) => {
      if (kw) return `<span class="j-kw">${kw}</span>`;
      if (num) return `<span class="j-num">${num}</span>`;
      if (oq && colon) {
        // It's a key
        return `<span class="j-key">${oq}${val}${cq}</span>${colon}`;
      }
      if (oq) {
        // It's a string value
        return `<span class="j-str">${oq}${val}${cq}</span>`;
      }
      return match;
    }
  );
}

// ──────────────────────────────────────────────
// Special tool input renderers
// ──────────────────────────────────────────────
function renderBashInput(input) {
  const cmd = safeStr(input?.command ?? '');
  if (!cmd) return null;
  const desc = input?.description ? `<div class="tool-desc">${esc(safeStr(input.description))}</div>` : '';
  return `${desc}<pre class="tool-cmd bash-cmd"><span class="bash-prompt">$</span> ${esc(cmd)}</pre>`;
}

function renderReadInput(input) {
  const fp = safeStr(input?.file_path ?? '');
  if (!fp) return null;
  const limit = input?.limit ? `<span class="tool-param">limit: ${esc(safeStr(input.limit))}</span>` : '';
  const offset = input?.offset ? `<span class="tool-param">offset: ${esc(safeStr(input.offset))}</span>` : '';
  return `<div class="file-path-display"><span class="file-icon">📄</span><code class="filepath">${esc(fp)}</code>${limit}${offset}</div>`;
}

function renderEditInput(input) {
  const fp = safeStr(input?.file_path ?? '');
  const oldStr = safeStr(input?.old_string ?? '');
  const newStr = safeStr(input?.new_string ?? '');
  if (!fp) return null;
  const diffHtml = (oldStr || newStr)
    ? `<div class="diff-view">
        ${oldStr ? `<div class="diff-section diff-old"><div class="diff-label">− before</div><pre class="diff-pre">${esc(oldStr)}</pre></div>` : ''}
        ${newStr ? `<div class="diff-section diff-new"><div class="diff-label">+ after</div><pre class="diff-pre">${esc(newStr)}</pre></div>` : ''}
      </div>` : '';
  return `<div class="file-path-display"><span class="file-icon">✏️</span><code class="filepath">${esc(fp)}</code></div>${diffHtml}`;
}

function renderWriteInput(input) {
  const fp = safeStr(input?.file_path ?? '');
  const content = safeStr(input?.content ?? '');
  if (!fp) return null;
  const preview = content.length > 500 ? content.slice(0, 500) + '\n…' : content;
  return `<div class="file-path-display"><span class="file-icon">💾</span><code class="filepath">${esc(fp)}</code><span class="tool-param">${content.split('\n').length} lines</span></div>
    <pre class="tool-cmd">${esc(preview)}</pre>`;
}

function renderSpecialToolInput(name, input) {
  const n = safeStr(name).toLowerCase();
  if (n === 'bash') return renderBashInput(input);
  if (n === 'read') return renderReadInput(input);
  if (n === 'edit' || n === 'multiedit') return renderEditInput(input);
  if (n === 'write') return renderWriteInput(input);
  return null;
}

// ──────────────────────────────────────────────
// Block renderers
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
  if (!thinking) return '';
  const id = nextId();
  const preview = thinking.slice(0, 100).replace(/\n/g, ' ');
  const wordCount = thinking.trim().split(/\s+/).filter(Boolean).length;
  return `<div class="block block-thinking" data-type="thinking">
    <button class="collapsible-btn" onclick="toggleBlock('${id}')" aria-expanded="false">
      <span class="block-icon">🧠</span>
      <span class="block-label">Thinking</span>
      <span class="block-meta">${wordCount.toLocaleString()} words</span>
      <span class="preview" id="${id}-preview">${esc(preview)}${thinking.length > 100 ? '…' : ''}</span>
      <span class="chevron"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1l5 4-5 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>
    <div class="collapsible-body" id="${id}" hidden>
      <pre class="thinking-text">${esc(thinking)}</pre>
    </div>
  </div>`;
}

function renderToolUseBlock(block) {
  const name = safeStr(block.name ?? 'unknown');
  const id = nextId();
  const specialHtml = renderSpecialToolInput(name, block.input);
  const fallbackHtml = `<pre class="json-input">${syntaxHighlightJson(block.input)}</pre>`;
  const bodyHtml = specialHtml ?? fallbackHtml;
  const toolIcon = getToolIcon(name);
  return `<div class="block block-tool-use" data-type="tool_use" data-tool="${escAttr(name)}">
    <button class="collapsible-btn" onclick="toggleBlock('${id}')" aria-expanded="false">
      <span class="block-icon">${toolIcon}</span>
      <span class="block-label">Tool Call</span>
      <span class="tool-name">${esc(name)}</span>
      <span class="chevron"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1l5 4-5 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>
    <div class="collapsible-body" id="${id}" hidden>
      ${bodyHtml}
    </div>
  </div>`;
}

function getToolIcon(name) {
  const n = safeStr(name).toLowerCase();
  if (n === 'bash') return '⚡';
  if (n === 'read') return '📖';
  if (n === 'edit' || n === 'multiedit') return '✏️';
  if (n === 'write') return '💾';
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return '🔍';
  if (n.includes('web') || n.includes('fetch') || n.includes('http')) return '🌐';
  if (n.includes('git')) return '🔀';
  if (n.includes('task') || n.includes('agent')) return '🤖';
  if (n.includes('todo')) return '✅';
  if (n.includes('notebook')) return '📓';
  return '🔧';
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
  return `<div class="block block-tool-result${isError ? ' block-error' : ''}" data-type="tool_result">
    <button class="collapsible-btn" onclick="toggleBlock('${id}')" aria-expanded="false">
      <span class="block-icon">${isError ? '❌' : '✓'}</span>
      <span class="block-label">${isError ? 'Tool Error' : 'Tool Result'}</span>
      <span class="preview">${esc(text.slice(0, 80).replace(/\n/g, ' '))}${text.length > 80 ? '…' : ''}</span>
      <span class="chevron"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1l5 4-5 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>
    <div class="collapsible-body" id="${id}" hidden>
      <pre class="result-text">${esc(text)}</pre>
      ${truncated ? `<div class="truncation-note">… truncated — showing ${TRUNCATE_CHARS.toLocaleString()} of ${total.toLocaleString()} chars</div>` : ''}
    </div>
  </div>`;
}

function renderUnknownBlock(block) {
  const id = nextId();
  return `<div class="block block-unknown" data-type="unknown">
    <button class="collapsible-btn" onclick="toggleBlock('${id}')" aria-expanded="false">
      <span class="block-icon">❓</span>
      <span class="block-label">Unknown (${esc(block.type ?? '?')})</span>
      <span class="chevron"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1l5 4-5 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>
    <div class="collapsible-body" id="${id}" hidden>
      <pre class="json-input">${syntaxHighlightJson(block)}</pre>
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
// Turn card renderers
// ──────────────────────────────────────────────
function formatTs(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return safeStr(ts);
  }
}

function formatTsShort(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

function getTextPreview(blocks) {
  for (const b of blocks) {
    if (b.type === 'text') {
      const t = safeStr(b.text ?? b.content ?? '').trim().replace(/\n/g, ' ');
      return t.slice(0, 80) + (t.length > 80 ? '…' : '');
    }
    if (b.type === 'tool_use') {
      const name = safeStr(b.name ?? 'tool');
      const cmd = b.input?.command ? `: ${safeStr(b.input.command).slice(0, 50)}` : '';
      const fp = b.input?.file_path ? `: ${safeStr(b.input.file_path).slice(0, 50)}` : '';
      return `${name}${cmd || fp}`;
    }
    if (b.type === 'thinking') {
      const t = safeStr(b.thinking ?? '').trim().replace(/\n/g, ' ');
      return `[thinking] ${t.slice(0, 60)}${t.length > 60 ? '…' : ''}`;
    }
  }
  return '';
}

// Build sidebar turn list data
function buildTurns(records) {
  const turns = [];
  let turnIndex = 0;
  let cumulativeInput = 0;
  let cumulativeOutput = 0;

  for (const rec of records) {
    const type = rec?.type;
    if (type !== 'user' && type !== 'assistant') continue;

    const blocks = getContentBlocks(rec);
    if (blocks.length === 0) continue;

    const blocksHtml = blocks.map(renderBlock).join('');
    if (!blocksHtml.trim()) continue;

    const tok = getTokens(rec);
    if (tok) {
      cumulativeInput += tok.input;
      cumulativeOutput += tok.output;
    }

    turns.push({
      idx: turnIndex,
      type,
      ts: rec?.timestamp,
      preview: getTextPreview(blocks),
      blocks,
      blocksHtml,
      tok,
      cumulativeInput,
      cumulativeOutput,
      cardTypes: getCardTypes(blocks),
      model: getModel(rec),
    });
    turnIndex += 1;
  }

  return turns;
}

function renderTurnCard(turn) {
  const { idx, type, ts, blocksHtml, tok, cumulativeInput, cumulativeOutput, cardTypes, model } = turn;

  const tokHtml = tok
    ? `<div class="token-row">
        <span class="tok-item" title="Input tokens">in: ${tok.input.toLocaleString()}</span>
        <span class="tok-item" title="Output tokens">out: ${tok.output.toLocaleString()}</span>
        ${tok.cacheRead ? `<span class="tok-item tok-cache" title="Cache read">cache: ${tok.cacheRead.toLocaleString()}</span>` : ''}
        <span class="tok-cumulative" title="Cumulative total tokens">∑ ${(cumulativeInput + cumulativeOutput).toLocaleString()}</span>
      </div>`
    : '';

  const modelBadge = model
    ? `<span class="model-badge">${esc(model)}</span>`
    : '';

  return `<article class="card card-${esc(type)}" data-type="${esc(type)}" data-content-types="${esc(cardTypes)}" data-index="${idx}" id="turn-${idx}">
  <header class="card-header">
    <span class="role-badge role-${esc(type)}">${type === 'user' ? '👤 User' : '🤖 Assistant'}</span>
    ${ts ? `<span class="timestamp">${esc(formatTs(ts))}</span>` : ''}
    ${modelBadge}
    <button class="card-collapse-btn" onclick="toggleCard(${idx})" title="Collapse/expand turn">
      <svg width="12" height="12" viewBox="0 0 12 12" id="card-chevron-${idx}"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </header>
  <div class="card-body" id="card-body-${idx}">
    <div class="blocks-wrap">${blocksHtml}</div>
    ${tokHtml}
  </div>
</article>`;
}

// ──────────────────────────────────────────────
// Sidebar minimap
// ──────────────────────────────────────────────
function renderSidebar(turns) {
  const items = turns.map(t => {
    const icon = t.type === 'user' ? '👤' : '🤖';
    const label = t.type === 'user' ? 'U' : 'A';
    const preview = esc(t.preview.slice(0, 60));
    const ts = t.ts ? esc(formatTsShort(t.ts)) : '';
    return `<button class="sidebar-item sidebar-${esc(t.type)}" onclick="jumpTo(${t.idx})" title="${esc(t.preview)}" data-turn="${t.idx}">
      <span class="sidebar-index">${t.idx + 1}</span>
      <span class="sidebar-role">${label}</span>
      <span class="sidebar-preview">${preview || '(empty)'}</span>
      ${ts ? `<span class="sidebar-ts">${ts}</span>` : ''}
    </button>`;
  }).join('');

  return `<nav class="sidebar" id="sidebar" aria-label="Turn navigation">
  <div class="sidebar-header">
    <span class="sidebar-title">Turns</span>
    <button class="sidebar-toggle-btn" onclick="toggleSidebar()" title="Hide sidebar" id="sidebar-hide-btn">
      <svg width="14" height="14" viewBox="0 0 14 14"><path d="M9 2L4 7l5 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <div class="sidebar-items" id="sidebar-items">
${items}
  </div>
</nav>`;
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

  const maxCount = toolEntries.length > 0 ? toolEntries[0][1] : 1;

  const toolBarHtml = toolEntries.length > 0
    ? `<div class="stat-group stat-group-wide">
        <span class="stat-label">Tool calls</span>
        <div class="tool-bars">
          ${toolEntries.map(([name, count]) => {
            const pct = Math.max(4, Math.round((count / maxCount) * 100));
            return `<div class="tool-bar-row" title="${esc(name)}: ${count} calls">
              <span class="tool-bar-name">${esc(name)}</span>
              <div class="tool-bar-track"><div class="tool-bar-fill" style="width:${pct}%"></div></div>
              <span class="tool-bar-count">${count}</span>
            </div>`;
          }).join('')}
        </div>
      </div>`
    : '';

  const tokensHtml = stats.hasTokens
    ? `<div class="stat-group">
        <span class="stat-label">Tokens</span>
        <span class="stat-value">${(stats.totalInput + stats.totalOutput).toLocaleString()} total</span>
        <span class="stat-sub">in: ${stats.totalInput.toLocaleString()} · out: ${stats.totalOutput.toLocaleString()}${stats.totalCacheRead ? ` · cache: ${stats.totalCacheRead.toLocaleString()}` : ''}</span>
      </div>`
    : '';

  const modelsHtml = stats.models.length > 0
    ? `<div class="stat-group">
        <span class="stat-label">Model</span>
        ${stats.models.map(m => `<span class="stat-value model-pill">${esc(m)}</span>`).join('')}
      </div>`
    : '';

  const skippedHtml = skipped > 0
    ? `<div class="skipped-note">⚠ ${skipped} line${skipped > 1 ? 's' : ''} skipped (malformed JSON)</div>`
    : '';

  return `<section class="stats-header" id="stats-header">
  <div class="stats-title-row">
    <h1>Claude Code Session</h1>
    <span class="stats-duration">${formatDuration(stats.durationMs)}</span>
  </div>
  ${stats.firstTs ? `<div class="stats-timerange">${esc(formatTs(stats.firstTs))}${stats.lastTs && stats.lastTs !== stats.firstTs ? ` → ${esc(formatTs(stats.lastTs))}` : ''}</div>` : ''}
  <div class="stats-grid">
    <div class="stat-group">
      <span class="stat-label">Turns</span>
      <span class="stat-value">${stats.turns}</span>
      <span class="stat-sub">👤 ${stats.userTurns} user · 🤖 ${stats.assistantTurns} asst</span>
    </div>
    <div class="stat-group">
      <span class="stat-label">Thinking</span>
      <span class="stat-value">${stats.thinkingBlocks} blocks</span>
      ${stats.thinkingWords > 0 ? `<span class="stat-sub">${stats.thinkingWords.toLocaleString()} words</span>` : ''}
    </div>
    ${modelsHtml}
    ${tokensHtml}
    ${toolBarHtml}
  </div>
  ${skippedHtml}
</section>`;
}

// ──────────────────────────────────────────────
// Toolbar HTML
// ──────────────────────────────────────────────
function renderToolbar() {
  return `<div class="toolbar" id="toolbar">
  <div class="toolbar-left">
    <button class="toolbar-btn sidebar-show-btn" id="sidebar-show-btn" onclick="toggleSidebar()" title="Show sidebar" style="display:none">
      <svg width="14" height="14" viewBox="0 0 14 14"><path d="M5 2l5 5-5 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="search-wrap">
      <svg class="search-icon" width="14" height="14" viewBox="0 0 14 14"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M9 9l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input type="search" id="searchBox" placeholder="Search transcript…" oninput="applySearch(this.value)" autocomplete="off" spellcheck="false">
      <span id="searchCount" class="search-count"></span>
    </div>
    <button class="toolbar-btn" id="prevMatch" onclick="navigateMatch(-1)" title="Previous match" disabled>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M8 10L4 6l4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="toolbar-btn" id="nextMatch" onclick="navigateMatch(1)" title="Next match" disabled>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <div class="toolbar-right">
    <div class="filter-group">
      <label class="filter-chip"><input type="checkbox" data-filter="user" checked><span>User</span></label>
      <label class="filter-chip"><input type="checkbox" data-filter="assistant" checked><span>Asst</span></label>
      <label class="filter-chip"><input type="checkbox" data-filter="thinking" checked><span>Think</span></label>
      <label class="filter-chip"><input type="checkbox" data-filter="tool_use" checked><span>Tools</span></label>
      <label class="filter-chip"><input type="checkbox" data-filter="tool_result" checked><span>Results</span></label>
    </div>
    <div class="action-group">
      <button class="toolbar-btn" onclick="expandAll()" title="Expand all">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4h8M2 7h5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
        All+
      </button>
      <button class="toolbar-btn" onclick="collapseAll()" title="Collapse all">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 5h8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
        All−
      </button>
      <button class="toolbar-btn theme-toggle" onclick="toggleTheme()" id="themeBtn" title="Toggle light/dark theme">
        <span id="themeIcon">☀</span>
      </button>
    </div>
  </div>
</div>`;
}

// ──────────────────────────────────────────────
// Inlined CSS — dark + light themes, premium design
// ──────────────────────────────────────────────
const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── Design tokens ─────────────────────────── */
:root {
  /* Dark theme (default) */
  --bg:           #0d0f14;
  --bg-surface:   #13161e;
  --bg-raised:    #1a1e2a;
  --bg-hover:     #1f2436;
  --border:       #252a3a;
  --border-subtle:#1c2030;
  --text:         #e6e9f4;
  --text-muted:   #6b7394;
  --text-faint:   #3d4564;

  --user:         #4f6ef7;
  --user-bg:      rgba(79,110,247,.08);
  --asst:         #10b981;
  --asst-bg:      rgba(16,185,129,.08);
  --think:        #a855f7;
  --think-bg:     rgba(168,85,247,.08);
  --tool:         #f59e0b;
  --tool-bg:      rgba(245,158,11,.08);
  --result:       #3b82f6;
  --result-bg:    rgba(59,130,246,.08);
  --err:          #ef4444;
  --err-bg:       rgba(239,68,68,.08);

  --hl:           #fbbf24;
  --hl-bg:        rgba(251,191,36,.25);
  --hl-active-bg: rgba(251,191,36,.55);

  --shadow:       0 1px 3px rgba(0,0,0,.4), 0 4px 12px rgba(0,0,0,.3);
  --shadow-sm:    0 1px 2px rgba(0,0,0,.3);
  --radius:       10px;
  --radius-sm:    6px;
  --sidebar-w:    260px;
  --toolbar-h:    52px;

  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color-scheme: dark;
}

/* Light theme */
:root[data-theme="light"] {
  --bg:           #f8f9fc;
  --bg-surface:   #ffffff;
  --bg-raised:    #f2f4f8;
  --bg-hover:     #eaecf4;
  --border:       #dde1ec;
  --border-subtle:#eef0f7;
  --text:         #1a1d2e;
  --text-muted:   #6b7394;
  --text-faint:   #b0b8d0;

  --user:         #3b5bdb;
  --user-bg:      rgba(59,91,219,.06);
  --asst:         #059669;
  --asst-bg:      rgba(5,150,105,.06);
  --think:        #7c3aed;
  --think-bg:     rgba(124,58,237,.06);
  --tool:         #d97706;
  --tool-bg:      rgba(217,119,6,.06);
  --result:       #2563eb;
  --result-bg:    rgba(37,99,235,.06);
  --err:          #dc2626;
  --err-bg:       rgba(220,38,38,.06);

  --hl-bg:        rgba(251,191,36,.35);
  --hl-active-bg: rgba(251,191,36,.65);
  --shadow:       0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06);
  --shadow-sm:    0 1px 2px rgba(0,0,0,.06);
  color-scheme: light;
}

/* ── Base ───────────────────────────────────── */
html { scroll-behavior: smooth; }
body { background: var(--bg); color: var(--text); min-height: 100vh; }
code, pre, .monospace { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace; }

/* ── Layout ─────────────────────────────────── */
.layout {
  display: flex;
  min-height: 100vh;
  padding-top: var(--toolbar-h);
}
.sidebar {
  position: fixed;
  top: var(--toolbar-h);
  left: 0;
  bottom: 0;
  width: var(--sidebar-w);
  background: var(--bg-surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 20;
  transition: transform .25s cubic-bezier(.4,0,.2,1);
}
.sidebar.hidden {
  transform: translateX(calc(-1 * var(--sidebar-w)));
}
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.sidebar-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--text-muted);
}
.sidebar-toggle-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
}
.sidebar-toggle-btn:hover { background: var(--bg-hover); color: var(--text); }
.sidebar-items {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.sidebar-items::-webkit-scrollbar { width: 4px; }
.sidebar-items::-webkit-scrollbar-track { background: transparent; }
.sidebar-items::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.sidebar-item {
  display: grid;
  grid-template-columns: 26px 16px 1fr;
  grid-template-rows: auto auto;
  column-gap: 6px;
  align-items: start;
  width: 100%;
  padding: 7px 10px 7px 8px;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  border-bottom: 1px solid var(--border-subtle);
  transition: background .12s;
  color: var(--text);
}
.sidebar-item:hover { background: var(--bg-hover); }
.sidebar-item.active { background: var(--bg-hover); border-left: 2px solid var(--user); }
.sidebar-user.active { border-left-color: var(--user); }
.sidebar-assistant.active { border-left-color: var(--asst); }
.sidebar-index {
  font-size: 10px;
  color: var(--text-faint);
  font-family: monospace;
  line-height: 1.8;
}
.sidebar-role {
  font-size: 10px;
  font-weight: 700;
  line-height: 1.8;
}
.sidebar-user .sidebar-role { color: var(--user); }
.sidebar-assistant .sidebar-role { color: var(--asst); }
.sidebar-preview {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  grid-column: 3;
  line-height: 1.6;
}
.sidebar-ts {
  font-size: 9px;
  color: var(--text-faint);
  font-family: monospace;
  grid-column: 3;
  line-height: 1.4;
}

/* ── Main content ───────────────────────────── */
.main-wrap {
  flex: 1;
  margin-left: var(--sidebar-w);
  min-width: 0;
  transition: margin-left .25s cubic-bezier(.4,0,.2,1);
}
.main-wrap.sidebar-hidden {
  margin-left: 0;
}
.main-content {
  max-width: 860px;
  margin: 0 auto;
  padding: 20px 20px 80px;
}

/* ── Toolbar ─────────────────────────────────── */
.toolbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--toolbar-h);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  z-index: 30;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.toolbar-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: all .12s;
  font-family: inherit;
}
.toolbar-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
  border-color: var(--text-muted);
}
.toolbar-btn:disabled { opacity: .4; cursor: default; }
.theme-toggle { padding: 5px 8px; font-size: 14px; }

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  max-width: 380px;
}
.search-icon {
  position: absolute;
  left: 9px;
  color: var(--text-muted);
  pointer-events: none;
}
#searchBox {
  width: 100%;
  padding: 7px 10px 7px 30px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color .15s;
}
#searchBox:focus {
  border-color: var(--user);
  background: var(--bg-surface);
}
#searchBox::placeholder { color: var(--text-faint); }
.search-count {
  position: absolute;
  right: 8px;
  font-size: 11px;
  color: var(--text-muted);
  pointer-events: none;
  white-space: nowrap;
}

.filter-group {
  display: flex;
  gap: 4px;
  flex-wrap: nowrap;
}
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}
.filter-chip input { display: none; }
.filter-chip span {
  display: inline-block;
  padding: 4px 9px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  color: var(--text-muted);
  transition: all .12s;
  cursor: pointer;
}
.filter-chip input:checked + span {
  background: var(--user-bg);
  border-color: var(--user);
  color: var(--user);
}
.filter-chip:nth-child(2) input:checked + span { background: var(--asst-bg); border-color: var(--asst); color: var(--asst); }
.filter-chip:nth-child(3) input:checked + span { background: var(--think-bg); border-color: var(--think); color: var(--think); }
.filter-chip:nth-child(4) input:checked + span { background: var(--tool-bg); border-color: var(--tool); color: var(--tool); }
.filter-chip:nth-child(5) input:checked + span { background: var(--result-bg); border-color: var(--result); color: var(--result); }
.action-group { display: flex; gap: 4px; }

/* ── Stats header ───────────────────────────── */
.stats-header {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px 22px;
  margin-bottom: 16px;
  box-shadow: var(--shadow-sm);
}
.stats-title-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 2px;
}
.stats-title-row h1 {
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: -.02em;
  color: var(--text);
}
.stats-duration {
  font-size: 0.82rem;
  color: var(--text-muted);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 1px 10px;
}
.stats-timerange {
  font-size: 0.78rem;
  color: var(--text-faint);
  margin-bottom: 14px;
  font-family: monospace;
}
.stats-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 20px 32px;
  align-items: start;
}
.stat-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat-group-wide { flex: 1; min-width: 240px; }
.stat-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .07em;
  color: var(--text-muted);
}
.stat-value {
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text);
  line-height: 1.3;
}
.stat-sub {
  font-size: 11px;
  color: var(--text-muted);
}
.model-pill {
  font-size: 0.78rem !important;
  font-weight: 600;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 8px;
}

/* Tool bars */
.tool-bars { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.tool-bar-row {
  display: grid;
  grid-template-columns: 120px 1fr 30px;
  align-items: center;
  gap: 8px;
}
.tool-bar-name {
  font-size: 11px;
  font-family: monospace;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-bar-track {
  height: 5px;
  background: var(--bg-raised);
  border-radius: 3px;
  overflow: hidden;
}
.tool-bar-fill {
  height: 100%;
  background: var(--tool);
  border-radius: 3px;
  opacity: .8;
  transition: width .3s ease;
}
.tool-bar-count {
  font-size: 11px;
  color: var(--text-muted);
  text-align: right;
  font-family: monospace;
}
.skipped-note {
  margin-top: 12px;
  font-size: 12px;
  color: var(--err);
  padding: 6px 10px;
  background: var(--err-bg);
  border-radius: var(--radius-sm);
  border: 1px solid var(--err);
}

/* ── Cards ──────────────────────────────────── */
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 10px;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  transition: box-shadow .15s;
}
.card:hover { box-shadow: var(--shadow); }
.card[hidden] { display: none !important; }
.card.search-hidden { display: none !important; }

.card-user { border-left: 3px solid var(--user); }
.card-assistant { border-left: 3px solid var(--asst); }
.card-other { border-left: 3px solid var(--text-faint); }

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
}
.role-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
  padding: 2px 10px;
  border-radius: 20px;
}
.role-user { background: var(--user-bg); color: var(--user); border: 1px solid rgba(79,110,247,.2); }
.role-assistant { background: var(--asst-bg); color: var(--asst); border: 1px solid rgba(16,185,129,.2); }
.timestamp { color: var(--text-faint); font-size: 11px; font-family: monospace; }
.model-badge {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-faint);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  font-family: monospace;
}
.card-collapse-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-faint);
  padding: 2px 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transition: color .12s, background .12s;
}
.card-collapse-btn:hover { color: var(--text); background: var(--bg-hover); }

.card-body { }
.card-body.collapsed { display: none; }
.blocks-wrap { padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; }

/* Token row */
.token-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-raised);
  font-size: 11px;
}
.tok-item { color: var(--text-muted); font-family: monospace; }
.tok-cache { color: var(--result); }
.tok-cumulative { margin-left: auto; color: var(--text-faint); font-family: monospace; }

/* ── Blocks ──────────────────────────────────── */
.block { border-radius: var(--radius-sm); overflow: hidden; }
.text-content {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
}

.collapsible-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  color: var(--text);
  padding: 7px 10px;
  font-size: 12px;
  font-family: inherit;
  transition: filter .1s;
}
.collapsible-btn:hover { filter: brightness(1.1); }
.block-thinking .collapsible-btn  { background: var(--think-bg); border: 1px solid rgba(168,85,247,.15); }
.block-tool-use .collapsible-btn  { background: var(--tool-bg);  border: 1px solid rgba(245,158,11,.15); }
.block-tool-result .collapsible-btn { background: var(--result-bg); border: 1px solid rgba(59,130,246,.15); }
.block-error .collapsible-btn     { background: var(--err-bg);   border: 1px solid rgba(239,68,68,.15); }
.block-unknown .collapsible-btn   { background: var(--bg-raised); border: 1px solid var(--border); }

.block-icon { font-size: 13px; flex-shrink: 0; }
.block-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .06em;
  padding: 1px 7px;
  border-radius: 20px;
  white-space: nowrap;
  flex-shrink: 0;
}
.block-thinking .block-label  { background: var(--think); color: #fff; }
.block-tool-use .block-label  { background: var(--tool);  color: #fff; }
.block-tool-result .block-label { background: var(--result); color: #fff; }
.block-error .block-label     { background: var(--err); color: #fff; }
.block-unknown .block-label   { background: var(--text-muted); color: var(--bg); }
.block-meta {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 1px 7px;
}

.tool-name {
  font-family: monospace;
  font-size: 12px;
  font-weight: 700;
  color: var(--tool);
}
.block-tool-result .tool-name { color: var(--result); }
.preview {
  color: var(--text-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.chevron {
  margin-left: auto;
  color: var(--text-faint);
  flex-shrink: 0;
  transition: transform .2s cubic-bezier(.4,0,.2,1);
}
.collapsible-btn[aria-expanded="true"] .chevron { transform: rotate(90deg); }

/* Collapsible body */
.collapsible-body {
  border-top: 1px solid rgba(255,255,255,.04);
}
:root[data-theme="light"] .collapsible-body {
  border-top-color: rgba(0,0,0,.06);
}
.collapsible-body pre {
  margin: 0;
  padding: 12px 14px;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  background: var(--bg);
  color: var(--text);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
}
.thinking-text { color: #c4a8e8; }
:root[data-theme="light"] .thinking-text { color: #6d28d9; }

/* JSON syntax highlighting */
.j-key { color: #93c5fd; }
.j-str { color: #86efac; }
.j-num { color: #fbbf24; }
.j-kw  { color: #f9a8d4; }
:root[data-theme="light"] .j-key { color: #1d4ed8; }
:root[data-theme="light"] .j-str { color: #15803d; }
:root[data-theme="light"] .j-num { color: #b45309; }
:root[data-theme="light"] .j-kw  { color: #7c3aed; }

/* Special tool inputs */
.bash-cmd {
  background: var(--bg) !important;
  color: #86efac !important;
  padding: 10px 14px !important;
}
:root[data-theme="light"] .bash-cmd { color: #166534 !important; }
.bash-prompt { color: var(--text-faint); user-select: none; }
.tool-cmd { color: var(--text); }
.tool-desc {
  padding: 8px 14px 0;
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}
.file-path-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 12px;
}
.file-icon { font-size: 14px; }
.filepath {
  font-family: monospace;
  font-size: 12px;
  color: var(--result);
  background: var(--result-bg);
  border: 1px solid rgba(59,130,246,.15);
  border-radius: 4px;
  padding: 1px 8px;
}
:root[data-theme="light"] .filepath { color: #1d4ed8; }
.tool-param {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}

/* Diff view */
.diff-view { padding: 0 14px 8px; display: flex; flex-direction: column; gap: 6px; }
.diff-section { border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border); }
.diff-label {
  padding: 3px 10px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .05em;
}
.diff-old .diff-label { background: rgba(239,68,68,.12); color: var(--err); border-bottom: 1px solid var(--border); }
.diff-new .diff-label { background: rgba(16,185,129,.12); color: var(--asst); border-bottom: 1px solid var(--border); }
.diff-pre {
  margin: 0 !important;
  background: var(--bg) !important;
  padding: 8px 12px !important;
  font-size: 11px !important;
  max-height: 300px;
  overflow-y: auto;
}
.diff-old .diff-pre { color: #fca5a5 !important; }
.diff-new .diff-pre { color: #86efac !important; }
:root[data-theme="light"] .diff-old .diff-pre { color: #b91c1c !important; }
:root[data-theme="light"] .diff-new .diff-pre { color: #166534 !important; }

.result-text { color: var(--text); }
.truncation-note {
  padding: 6px 14px;
  font-size: 11px;
  color: var(--err);
  background: var(--err-bg);
  border-top: 1px solid var(--border);
}

/* ── Search highlight ───────────────────────── */
mark {
  background: var(--hl-bg);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
  transition: background .1s;
}
mark.active-match { background: var(--hl-active-bg); outline: 2px solid var(--hl); }

/* ── Filter hidden ──────────────────────────── */
.block[data-hidden-filter] { display: none; }

/* ── Animations ─────────────────────────────── */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.card { animation: fadeIn .2s ease both; }

/* ── Scrollbar ──────────────────────────────── */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
*::-webkit-scrollbar { width: 6px; height: 6px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

/* ── Responsive ─────────────────────────────── */
@media (max-width: 768px) {
  :root { --sidebar-w: 220px; }
  .filter-group { display: none; }
  .main-content { padding: 12px 12px 60px; }
}
@media (max-width: 540px) {
  .sidebar { display: none; }
  .main-wrap { margin-left: 0 !important; }
  .model-badge { display: none; }
}
`;

// ──────────────────────────────────────────────
// Inlined JS (vanilla, no deps)
// ──────────────────────────────────────────────
const JS = `
// ── Theme ──────────────────────────────────────
(function() {
  var saved = localStorage.getItem('cc-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeIcon').textContent = saved === 'light' ? '🌙' : '☀';
})();

function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('cc-theme', next);
  document.getElementById('themeIcon').textContent = next === 'light' ? '🌙' : '☀';
}

// ── Sidebar ─────────────────────────────────────
var sidebarVisible = true;

function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  var sidebar = document.getElementById('sidebar');
  var mainWrap = document.querySelector('.main-wrap');
  var showBtn = document.getElementById('sidebar-show-btn');
  if (sidebarVisible) {
    sidebar.classList.remove('hidden');
    mainWrap.classList.remove('sidebar-hidden');
    showBtn.style.display = 'none';
  } else {
    sidebar.classList.add('hidden');
    mainWrap.classList.add('sidebar-hidden');
    showBtn.style.display = '';
  }
}

function jumpTo(idx) {
  var el = document.getElementById('turn-' + idx);
  if (!el) return;
  // Expand card body if collapsed
  var body = document.getElementById('card-body-' + idx);
  if (body && body.classList.contains('collapsed')) {
    body.classList.remove('collapsed');
    updateCardChevron(idx, false);
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Highlight active sidebar item
  document.querySelectorAll('.sidebar-item').forEach(function(btn) {
    btn.classList.toggle('active', parseInt(btn.dataset.turn) === idx);
  });
}

// Update active sidebar item on scroll
var lastActiveTurn = -1;
function updateSidebarActive() {
  var cards = document.querySelectorAll('.card[id^=turn-]');
  var scrollY = window.scrollY + 100;
  var active = -1;
  cards.forEach(function(card) {
    var top = card.getBoundingClientRect().top + window.scrollY;
    if (top <= scrollY) active = parseInt(card.dataset.index);
  });
  if (active !== lastActiveTurn) {
    lastActiveTurn = active;
    document.querySelectorAll('.sidebar-item').forEach(function(btn) {
      btn.classList.toggle('active', parseInt(btn.dataset.turn) === active);
    });
    // Scroll sidebar item into view
    if (active >= 0) {
      var sidebarBtn = document.querySelector('.sidebar-item[data-turn="' + active + '"]');
      if (sidebarBtn) {
        var items = document.getElementById('sidebar-items');
        var itemTop = sidebarBtn.offsetTop;
        var itemHeight = sidebarBtn.offsetHeight;
        var containerScroll = items.scrollTop;
        var containerH = items.clientHeight;
        if (itemTop < containerScroll + 40 || itemTop + itemHeight > containerScroll + containerH - 40) {
          items.scrollTo({ top: itemTop - containerH / 2, behavior: 'smooth' });
        }
      }
    }
  }
}
window.addEventListener('scroll', updateSidebarActive, { passive: true });

// ── Card collapse/expand ─────────────────────────
function toggleCard(idx) {
  var body = document.getElementById('card-body-' + idx);
  if (!body) return;
  var collapsed = body.classList.toggle('collapsed');
  updateCardChevron(idx, collapsed);
}

function updateCardChevron(idx, collapsed) {
  var chevron = document.getElementById('card-chevron-' + idx);
  if (chevron) {
    chevron.style.transform = collapsed ? 'rotate(-90deg)' : '';
  }
}

// ── Block collapse/expand ────────────────────────
function toggleBlock(id) {
  var body = document.getElementById(id);
  if (!body) return;
  var btn = body.previousElementSibling;
  var isHidden = body.hidden;
  body.hidden = !isHidden;
  if (btn) btn.setAttribute('aria-expanded', String(isHidden));
}

function expandAll() {
  document.querySelectorAll('.collapsible-body').forEach(function(el) {
    el.hidden = false;
    var btn = el.previousElementSibling;
    if (btn) btn.setAttribute('aria-expanded', 'true');
  });
  document.querySelectorAll('.card-body').forEach(function(el) {
    el.classList.remove('collapsed');
  });
  document.querySelectorAll('[id^=card-chevron-]').forEach(function(el) {
    el.style.transform = '';
  });
}

function collapseAll() {
  document.querySelectorAll('.collapsible-body').forEach(function(el) {
    el.hidden = true;
    var btn = el.previousElementSibling;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}

// ── Filtering ────────────────────────────────────
var activeFilters = {
  user: true, assistant: true,
  text: true, thinking: true, tool_use: true, tool_result: true
};

document.querySelectorAll('[data-filter]').forEach(function(cb) {
  cb.addEventListener('change', function() {
    activeFilters[cb.dataset.filter] = cb.checked;
    applyFilters();
  });
});

function applyFilters() {
  document.querySelectorAll('.card').forEach(function(card) {
    var cardType = card.dataset.type;
    var roleOk = activeFilters[cardType] !== false;

    card.querySelectorAll('.block[data-type]').forEach(function(block) {
      var bt = block.dataset.type || 'other';
      var visible = activeFilters[bt] !== false;
      block.toggleAttribute('data-hidden-filter', !visible);
    });

    var anyBlockVisible = Array.from(card.querySelectorAll('.block[data-type]'))
      .some(function(b) { return !b.hasAttribute('data-hidden-filter'); });

    card.hidden = !roleOk || !anyBlockVisible;
  });
  updateSearchUI();
}

// ── Search ──────────────────────────────────────
var currentQuery = '';
var matchElements = [];
var currentMatchIdx = -1;

function applySearch(query) {
  currentQuery = query.toLowerCase().trim();

  // Remove all existing highlights
  document.querySelectorAll('mark[data-search]').forEach(function(m) {
    m.replaceWith(document.createTextNode(m.textContent));
  });
  document.querySelectorAll('.card').forEach(function(c) { c.normalize(); });
  matchElements = [];
  currentMatchIdx = -1;

  if (!currentQuery) {
    document.querySelectorAll('.card').forEach(function(card) {
      card.classList.remove('search-hidden');
    });
    updateSearchUI();
    return;
  }

  document.querySelectorAll('.card').forEach(function(card) {
    var text = card.innerText.toLowerCase();
    if (text.includes(currentQuery)) {
      card.classList.remove('search-hidden');
      highlightInNode(card, currentQuery);
    } else {
      card.classList.add('search-hidden');
    }
  });

  // Collect all marks in document order
  matchElements = Array.from(document.querySelectorAll('mark[data-search]'));

  // Navigate to first match
  if (matchElements.length > 0) {
    currentMatchIdx = 0;
    activateMatch(0);
  }
  updateSearchUI();
}

function navigateMatch(dir) {
  if (matchElements.length === 0) return;
  if (currentMatchIdx >= 0 && currentMatchIdx < matchElements.length) {
    matchElements[currentMatchIdx].classList.remove('active-match');
  }
  currentMatchIdx = (currentMatchIdx + dir + matchElements.length) % matchElements.length;
  activateMatch(currentMatchIdx);
  updateSearchUI();
}

function activateMatch(idx) {
  var el = matchElements[idx];
  if (!el) return;
  el.classList.add('active-match');
  // Expand parent collapsible if needed
  var p = el.parentElement;
  while (p) {
    if (p.id && p.classList.contains('collapsible-body') && p.hidden) {
      p.hidden = false;
      var btn = p.previousElementSibling;
      if (btn) btn.setAttribute('aria-expanded', 'true');
    }
    if (p.classList && p.classList.contains('card-body') && p.classList.contains('collapsed')) {
      p.classList.remove('collapsed');
    }
    p = p.parentElement;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function highlightInNode(root, query) {
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function(node) {
      var tag = node.parentNode.tagName;
      if (tag === 'MARK' || tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var nodes = [];
  var n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var val = node.nodeValue;
    var lower = val.toLowerCase();
    var idx = lower.indexOf(query);
    if (idx === -1) continue;
    var before = document.createTextNode(val.slice(0, idx));
    var mark = document.createElement('mark');
    mark.dataset.search = '1';
    mark.textContent = val.slice(idx, idx + query.length);
    var after = document.createTextNode(val.slice(idx + query.length));
    node.parentNode.replaceChild(after, node);
    node.parentNode.insertBefore(mark, after);
    node.parentNode.insertBefore(before, mark);
  }
}

function updateSearchUI() {
  var countEl = document.getElementById('searchCount');
  var prevBtn = document.getElementById('prevMatch');
  var nextBtn = document.getElementById('nextMatch');
  var total = document.querySelectorAll('.card').length;
  var visible = Array.from(document.querySelectorAll('.card'))
    .filter(function(c) { return !c.hidden && !c.classList.contains('search-hidden'); }).length;

  if (currentQuery) {
    var mc = matchElements.length;
    var cur = mc > 0 ? currentMatchIdx + 1 : 0;
    countEl.textContent = mc > 0 ? cur + '/' + mc + ' matches' : 'no matches';
    if (prevBtn) prevBtn.disabled = mc === 0;
    if (nextBtn) nextBtn.disabled = mc === 0;
  } else {
    countEl.textContent = '';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
  }
}

// Keyboard shortcut: / to focus search, Esc to clear, n/N to navigate
document.addEventListener('keydown', function(e) {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement !== document.getElementById('searchBox')) {
    e.preventDefault();
    document.getElementById('searchBox').focus();
  }
  if (e.key === 'Escape') {
    var sb = document.getElementById('searchBox');
    if (sb.value) { sb.value = ''; applySearch(''); sb.blur(); }
  }
  if ((e.key === 'n' || e.key === 'N') && currentQuery && document.activeElement !== document.getElementById('searchBox')) {
    e.preventDefault();
    navigateMatch(e.key === 'N' ? -1 : 1);
  }
});

// Initial state
applyFilters();
`;

// ──────────────────────────────────────────────
// Full HTML assembly
// ──────────────────────────────────────────────
function buildHtml({ statsHtml, toolbarHtml, sidebarHtml, cardsHtml, title }) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — cc-visualizer</title>
<style>
${CSS}
</style>
</head>
<body>
${toolbarHtml}
<div class="layout">
${sidebarHtml}
<div class="main-wrap" id="main-wrap">
<div class="main-content">
${statsHtml}
<div id="timeline">
${cardsHtml}
</div>
</div>
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
  const turns = buildTurns(records);

  const statsHtml   = renderStats(stats, skipped);
  const toolbarHtml = renderToolbar();
  const sidebarHtml = renderSidebar(turns);
  const cardsHtml   = turns.map(turn => {
    try {
      return renderTurnCard(turn);
    } catch (err) {
      return `<!-- turn ${turn.idx} render error: ${esc(err.message)} -->`;
    }
  }).join('\n');

  const title = basename(inputPath, '.jsonl');
  const html  = buildHtml({ statsHtml, toolbarHtml, sidebarHtml, cardsHtml, title });

  try {
    writeFileSync(outputPath, html, 'utf8');
  } catch (err) {
    console.error(`Error writing output: ${err.message}`);
    process.exit(1);
  }

  const bytes = Buffer.byteLength(html, 'utf8');
  const toolTotal = Object.values(stats.toolCounts).reduce((a, b) => a + b, 0);
  console.log(`cc-visualizer: ${records.length} records → ${turns.length} turns rendered`);
  console.log(`  User: ${stats.userTurns} | Assistant: ${stats.assistantTurns} | Tool calls: ${toolTotal} | Thinking: ${stats.thinkingBlocks}`);
  if (stats.models.length > 0) console.log(`  Models: ${stats.models.join(', ')}`);
  if (stats.hasTokens) console.log(`  Tokens: in=${stats.totalInput.toLocaleString()} out=${stats.totalOutput.toLocaleString()}`);
  if (skipped > 0) console.log(`  Skipped (malformed): ${skipped} lines`);
  console.log(`  Output: ${outputPath} (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`  Features: sidebar=${turns.length} items | themes=dark+light | search=next/prev | JSON-hl=yes`);
}

main();
