#!/usr/bin/env node
'use strict';
// token-plus control CLI, used by the slash commands:
//   node cli.js status | budget [off|normal|strict] | audit | raw [n] | init | reset
// Output is deliberately compact Markdown: it is printed into the conversation.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig, DEFAULTS, VALID_MODES, projectConfigPath } = require('../lib/config');
const state = require('../lib/state');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

function cfgNow() {
  const st = state.readState(projectDir);
  return loadConfig({ cwd: projectDir }, { stateMode: st.mode });
}

// ---------------------------------------------------------------- status

function status() {
  const st = state.readState(projectDir);
  const cfg = cfgNow();
  const ev = state.readEvents(projectDir);
  const by = (t) => ev.filter((e) => e.type === t);
  const sessions = Object.entries(st.sessions || {});
  const turns = sessions.reduce((a, [, s]) => a + (s.turns || 0), 0);
  const rewrites = by('rewrite');
  const results = by('rewrite-result');
  const applied = results.filter((r) => r.applied).length;
  const comp = by('compress');
  const sum = (arr, k) => arr.reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const origChars = sum(comp, 'origChars');
  const keptChars = sum(comp, 'keptChars');
  const linesSaved = sum(comp, 'origLines') - sum(comp, 'keptLines');
  const tok = Math.round((origChars - keptChars) * cfg.tokensPerChar);
  const heurLines = rewrites.reduce((a, e) => a + ((e.estimate && Number(e.estimate.lines)) || 0), 0);
  const errors = by('hook-error');
  const ruleCounts = {};
  for (const r of rewrites) ruleCounts[r.rule] = (ruleCounts[r.rule] || 0) + 1;

  const lines = [];
  lines.push(`## token-plus status — mode: \`${cfg.mode}\`${st.mode ? ' (set via /token-plus:budget)' : ''}`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Sessions tracked / turns monitored | ${fmt(sessions.length)} / ${fmt(turns)} |`);
  lines.push(`| Commands rewritten (proposed / confirmed applied) | ${fmt(rewrites.length)} / ${fmt(applied)}${results.length > applied ? ` (${results.length - applied} not applied by Claude Code)` : ''} |`);
  lines.push(`| Outputs compressed | ${fmt(comp.length)} |`);
  lines.push(`| Measured: chars removed from tool output | ${fmt(origChars - keptChars)} of ${fmt(origChars)} |`);
  lines.push(`| Measured: lines removed from tool output | ${fmt(linesSaved)} |`);
  lines.push(`| **Estimated tokens saved by compression** | **~${fmt(tok)}** (chars × ${cfg.tokensPerChar}) |`);
  lines.push(`| Heuristic: output lines avoided by rewrites | ~${fmt(heurLines)} (unverified counterfactual) |`);
  lines.push(`| Read-guard advisories / caps | ${fmt(by('read-advice').length)} / ${fmt(by('read-cap').length)} |`);
  lines.push(`| Compaction reminders issued | ${fmt(by('reminder').length)} |`);
  lines.push(`| Hook failures (passed through safely) | ${fmt(errors.length)} |`);
  if (Object.keys(ruleCounts).length) {
    lines.push('');
    lines.push('Rewrites by rule: ' + Object.entries(ruleCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', '));
  }
  if (errors.length) {
    lines.push('');
    lines.push('Recent hook failures:');
    for (const e of errors.slice(-3)) lines.push(`- ${e.t} ${e.hook}: ${e.error}`);
  }
  if (cfg._warnings.length) {
    lines.push('');
    lines.push('Config warnings: ' + cfg._warnings.join('; '));
  }
  lines.push('');
  lines.push('_All token figures are estimates (characters × tokensPerChar), not billing data. Use `/usage` or `/context` for authoritative numbers._');
  return lines.join('\n');
}

// ---------------------------------------------------------------- budget

function budget(mode) {
  if (!mode) {
    const cfg = cfgNow();
    return `token-plus mode is \`${cfg.mode}\`. Usage: /token-plus:budget off|normal|strict`;
  }
  if (!VALID_MODES.includes(mode)) return `Unknown mode "${mode}". Use one of: ${VALID_MODES.join(', ')}.`;
  const res = state.updateState(projectDir, (s) => {
    s.mode = mode;
    return s;
  });
  if (!res) return 'Could not write .claude/token-plus-state.json (check permissions). Mode unchanged.';
  state.appendEvent(projectDir, { type: 'mode', mode });
  const desc = {
    off: 'all rewriting, compression, read guard and reminders disabled (hooks pass everything through).',
    normal: 'safe rewrites, compression above 150 lines / 6,000 chars, advisory read guard.',
    strict: 'tighter thresholds (80 lines / 4,000 chars), shorter git log, diff -U1, large cat → head, Read capped at largeFileWarningLines.',
  };
  return `token-plus mode set to \`${mode}\` for this project: ${desc[mode]} Takes effect on the next tool call.`;
}

// ---------------------------------------------------------------- audit

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
}

function fileSize(f) {
  try {
    const st = fs.statSync(f);
    return st.isFile() ? st.size : null;
  } catch (_) {
    return null;
  }
}

function encodeProject(dir) {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

// Scan recent transcripts for MCP tool usage (bounded I/O).
function mcpUsage(home) {
  const dir = path.join(home, '.claude', 'projects', encodeProject(projectDir));
  const used = {};
  let scanned = 0;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 20);
    for (const { f } of files) {
      const size = fileSize(f) || 0;
      const fd = fs.openSync(f, 'r');
      const len = Math.min(size, 8 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const re = /"name":"mcp__([^"_]+(?:_[^"_]+)*)__/g;
      let m;
      while ((m = re.exec(text))) used[m[1]] = (used[m[1]] || 0) + 1;
      scanned++;
    }
  } catch (_) {
    /* no transcripts */
  }
  return { used, scanned };
}

function audit() {
  const home = process.env.TOKEN_PLUS_HOME || os.homedir();
  const out = [];
  const recs = [];
  out.push('## token-plus audit (read-only — nothing was changed)');

  // MCP servers
  const servers = {};
  const userCfg = readJson(path.join(home, '.claude.json')) || {};
  for (const [n, v] of Object.entries(userCfg.mcpServers || {})) servers[n] = { scope: 'user', v };
  const proj = (userCfg.projects || {})[projectDir] || {};
  for (const [n, v] of Object.entries(proj.mcpServers || {})) servers[n] = { scope: 'local', v };
  const mcpJson = readJson(path.join(projectDir, '.mcp.json')) || {};
  for (const [n, v] of Object.entries(mcpJson.mcpServers || {})) servers[n] = { scope: 'project (.mcp.json)', v };
  const { used, scanned } = mcpUsage(home);
  out.push('');
  out.push(`### MCP servers (${Object.keys(servers).length} configured; usage from last ${scanned} transcripts)`);
  if (!Object.keys(servers).length) out.push('- none found in ~/.claude.json or .mcp.json (plugin/connector servers are not listed here; check `/mcp`)');
  for (const [n, s] of Object.entries(servers)) {
    const key = n.replace(/[^A-Za-z0-9_-]/g, '_');
    const calls = used[key] || used[n] || 0;
    out.push(`- \`${n}\` (${s.scope}) — ${calls ? `${calls} tool calls seen` : '**no calls seen**'}`);
    if (!calls && scanned) recs.push(`MCP server \`${n}\` shows no recent use. Its tool definitions still occupy context every turn; consider disabling it for this project via \`/mcp\` (token-plus will not change MCP config for you).`);
  }
  const otherUsed = Object.keys(used).filter((k) => !servers[k]);
  if (otherUsed.length) out.push(`- other MCP servers used recently: ${otherUsed.map((k) => `\`${k}\` (${used[k]})`).join(', ')}`);

  // CLAUDE.md
  out.push('');
  out.push('### Always-loaded instructions');
  const mdFiles = [
    path.join(projectDir, 'CLAUDE.md'),
    path.join(projectDir, '.claude', 'CLAUDE.md'),
    path.join(projectDir, 'CLAUDE.local.md'),
    path.join(home, '.claude', 'CLAUDE.md'),
  ];
  let anyMd = false;
  for (const f of mdFiles) {
    const sz = fileSize(f);
    if (sz == null) continue;
    anyMd = true;
    const tok = Math.round(sz / 4);
    const lines = fs.readFileSync(f, 'utf8').split('\n').length;
    out.push(`- \`${f.replace(home, '~')}\`: ${fmt(lines)} lines, ~${fmt(tok)} tokens est. (loaded every session)`);
    if (tok > 2500) recs.push(`\`${path.basename(f)}\` is ~${fmt(tok)} tokens. Move workflow-specific sections (release steps, migration guides, style minutiae) into on-demand skills; keep CLAUDE.md to build/test commands and hard rules.`);
  }
  if (!anyMd) out.push('- no CLAUDE.md files found');

  // Plugins / skills
  out.push('');
  out.push('### Plugins and skills adding persistent context');
  const settings = [path.join(home, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.local.json')];
  const enabled = new Set();
  for (const f of settings) {
    const s = readJson(f);
    if (s && s.enabledPlugins) for (const [k, v] of Object.entries(s.enabledPlugins)) if (v) enabled.add(k);
  }
  out.push(`- enabled plugins (settings files): ${enabled.size ? [...enabled].map((p) => `\`${p}\``).join(', ') : 'none listed'}`);
  if (enabled.size > 8) recs.push(`${enabled.size} plugins are enabled. Each contributes skill/agent/command descriptions to every session; disable the ones you don't use in this project with \`/plugin\`.`);
  let skillCount = 0;
  for (const d of [path.join(home, '.claude', 'skills'), path.join(projectDir, '.claude', 'skills')]) {
    try {
      skillCount += fs.readdirSync(d).filter((x) => fs.existsSync(path.join(d, x, 'SKILL.md'))).length;
    } catch (_) {
      /* none */
    }
  }
  out.push(`- standalone skills (user + project): ${skillCount} (each adds its description line to context)`);
  try {
    const agents = fs.readdirSync(path.join(projectDir, '.claude', 'agents')).filter((f) => f.endsWith('.md'));
    out.push(`- project subagents: ${agents.length}`);
  } catch (_) {
    /* none */
  }

  // Heavy commands
  const ev = state.readEvents(projectDir);
  const heavy = {};
  for (const e of ev.filter((x) => x.type === 'bash-output' || x.type === 'compress')) {
    const key = (e.cmd || '').split(/\s+/).slice(0, 3).join(' ');
    if (!key) continue;
    heavy[key] = heavy[key] || { n: 0, chars: 0 };
    heavy[key].n++;
    heavy[key].chars += Number(e.chars || e.origChars || 0);
  }
  const top = Object.entries(heavy).sort((a, b) => b[1].chars - a[1].chars).slice(0, 8);
  out.push('');
  out.push('### Heaviest recent Bash commands (raw output size)');
  if (!top.length) out.push('- no large outputs recorded yet');
  for (const [k, v] of top) out.push(`- \`${k}\` — ${v.n}× , ~${fmt(Math.round(v.chars / 4))} tokens est. raw`);
  if (top.length && top[0][1].chars > 200000) recs.push(`\`${top[0][0]}\` produced the most output. Run it with narrower arguments, or delegate it to a subagent that returns only a summary.`);
  const reads = ev.filter((e) => e.type === 'read-advice' || e.type === 'read-cap');
  if (reads.length > 5) recs.push(`${reads.length} large/repeated file reads were flagged. The \`token-plus:targeted-reading\` skill and a project brief (\`token-plus:project-brief\`) reduce exploratory reads.`);

  const cfg = cfgNow();
  if (cfg.mode === 'off') recs.push('token-plus is in `off` mode; run `/token-plus:budget normal` to re-enable.');

  out.push('');
  out.push('### Recommendations');
  if (!recs.length) out.push('- Nothing significant found.');
  for (const r of recs) out.push(`- ${r}`);
  out.push('');
  out.push('_Estimates use chars/4. Verify with `/context` (per-category context usage) and `/mcp`._');
  return out.join('\n');
}

// ---------------------------------------------------------------- raw / init / reset

function raw(arg) {
  const files = state.listRaw(projectDir);
  if (!files.length) return 'No saved raw outputs yet.';
  const n = Math.max(1, Math.min(files.length, parseInt(arg || '5', 10) || 5));
  const rows = files.slice(-n).reverse().map((f) => {
    const sz = fileSize(f) || 0;
    let first = '';
    try {
      first = fs.readFileSync(f, 'utf8').split('\n', 1)[0].slice(0, 100);
    } catch (_) {
      /* ignore */
    }
    return `- \`${path.relative(projectDir, f)}\` (${fmt(sz)} bytes) ${first}`;
  });
  return `Most recent full (uncompressed) outputs — read a slice with Read offset/limit or \`sed -n\`:\n${rows.join('\n')}`;
}

function init() {
  const f = projectConfigPath(projectDir);
  if (fs.existsSync(f)) return `${path.relative(projectDir, f)} already exists; not overwritten.`;
  const cfg = Object.assign({}, DEFAULTS);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  return `Wrote ${path.relative(projectDir, f)} with documented defaults. See README "Configuration".`;
}

function reset() {
  const p = state.paths(projectDir);
  for (const f of [p.events, `${p.events}.1`]) {
    try {
      fs.unlinkSync(f);
    } catch (_) {
      /* ignore */
    }
  }
  state.updateState(projectDir, (s) => {
    s.sessions = {};
    return s;
  });
  return 'token-plus telemetry reset (mode and config kept; raw outputs kept — delete .claude/token-plus/raw to remove them).';
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  let out;
  try {
    switch (cmd) {
      case 'status':
        out = status();
        break;
      case 'budget':
        out = budget(arg);
        break;
      case 'audit':
        out = audit();
        break;
      case 'raw':
        out = raw(arg);
        break;
      case 'init':
        out = init();
        break;
      case 'reset':
        out = reset();
        break;
      default:
        out = 'Usage: cli.js status | budget [off|normal|strict] | audit | raw [n] | init | reset';
    }
  } catch (err) {
    out = `token-plus: command failed: ${err && err.message}`;
  }
  process.stdout.write(out + '\n');
}

if (require.main === module) main();
module.exports = { status, budget, audit, raw, init, reset };
