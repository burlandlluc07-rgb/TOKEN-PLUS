'use strict';
// Hook handlers. Each takes the parsed hook input and the effective config and returns
// the JSON object to print on stdout, or null for "no opinion / pass through".
// Handlers must never throw for normal inputs; hook.js additionally wraps them.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { sanitizeCommand, matchProtectedPath } = require('./sanitizer');
const { compress, estimateTokens } = require('./compressor');
const state = require('./state');

const SESSION_RULES = [
  'token-plus context discipline:',
  '- Large files: search first (Grep/Glob with narrow patterns and paths), then Read only the relevant line range.',
  '- Never echo file contents or tool output back; summarize and cite path:line.',
  '- Do not re-read a file you already have unless it changed.',
  '- Prefer CLI tools over equivalent MCP tools.',
  '- Delegate verbose read-only exploration to a subagent; keep only its summary.',
  '- If a request is ambiguous, ask instead of scanning the whole repository.',
  '- "[token-plus: elided …]" marks compressed output; the full text is in the named raw log, read a slice only if needed. Prefix a command with TP_RAW=1 to bypass rewriting and compression.',
].join('\n');

const ROUTING_RULE =
  '- Optional cheap helpers: token-plus:quick-reader (summarize files/logs/docs), token-plus:quick-reviewer (small focused diff review), token-plus:doc-writer (localized docs). Never use them for architecture, security, complex debugging or irreversible actions.';

const COMPACT_FOCUS = 'Preserve current task, changed files, failing tests, commands run, and next steps.';

function sessionId(input) {
  return (input && input.session_id) || 'unknown';
}

function hookOut(event, fields) {
  return { hookSpecificOutput: Object.assign({ hookEventName: event }, fields) };
}

// ---------------------------------------------------------------- PreToolUse(Bash)

function preBash(input, cfg) {
  if (cfg.mode === 'off') return null;
  const ti = (input && input.tool_input) || {};
  const command = ti.command;
  if (typeof command !== 'string') return null;
  const res = sanitizeCommand(command, cfg, { cwd: input.cwd || cfg._projectDir });
  const dir = cfg._projectDir;
  if (res.advisory) {
    state.appendEvent(dir, { sid: sessionId(input), type: 'advice', rule: res.rule, reason: res.reason });
    return res.note ? hookOut('PreToolUse', { additionalContext: res.note }) : null;
  }
  if (!res.changed) return null;
  state.appendEvent(dir, {
    sid: sessionId(input),
    type: 'rewrite',
    rule: res.rule,
    reason: res.reason,
    original: command.slice(0, 500),
    rewritten: res.command.slice(0, 700),
    estimate: res.estimate || null,
  });
  state.writePending(dir, input.tool_use_id, { original: command, rewritten: res.command, rule: res.rule, t: Date.now() });
  const fields = {
    updatedInput: Object.assign({}, ti, { command: res.command }),
    permissionDecisionReason: `token-plus: ${res.reason}`,
  };
  if (cfg.rewritePermission === 'ask' || cfg.rewritePermission === 'allow') fields.permissionDecision = cfg.rewritePermission;
  if (res.note) fields.additionalContext = res.note;
  return hookOut('PreToolUse', fields);
}

// ---------------------------------------------------------------- PostToolUse(Bash)

function splitResponse(resp) {
  if (typeof resp === 'string') return { kind: 'string', stdout: resp, stderr: '' };
  if (resp && typeof resp === 'object') {
    if (resp.isImage) return null;
    const stdout = typeof resp.stdout === 'string' ? resp.stdout : typeof resp.output === 'string' ? resp.output : null;
    if (stdout === null) return null;
    return { kind: 'object', key: typeof resp.stdout === 'string' ? 'stdout' : 'output', stdout, stderr: typeof resp.stderr === 'string' ? resp.stderr : '' };
  }
  return null;
}

function postBash(input, cfg) {
  const dir = cfg._projectDir;
  const ti = (input && input.tool_input) || {};
  const command = typeof ti.command === 'string' ? ti.command : '';
  const pending = state.takePending(dir, input.tool_use_id);
  if (pending) {
    state.appendEvent(dir, {
      sid: sessionId(input),
      type: 'rewrite-result',
      rule: pending.rule,
      applied: command === pending.rewritten,
    });
  }
  if (cfg.mode === 'off' || !cfg.enableOutputCompression) return null;
  if (/^\s*TP_RAW=/.test(command) || /&&\s*TP_RAW=/.test(command)) return null;
  // Never persist or alter output of commands touching secrets.
  if (matchProtectedPath(command, cfg.protectedPaths || [])) return null;

  const resp = input.tool_response;
  const parts = splitResponse(resp);
  if (!parts) return null;
  const total = parts.stdout.length + parts.stderr.length;
  if (total > 2000) {
    state.appendEvent(dir, { sid: sessionId(input), type: 'bash-output', cmd: command.slice(0, 120), chars: total });
  }

  const probeOut = compress(parts.stdout, cfg, { command });
  const probeErr = compress(parts.stderr, cfg, { command });
  if (!probeOut.changed && !probeErr.changed) return null;

  let rawPath = null;
  if (cfg.saveRawOutput) {
    const body = `$ ${command}\n--- stdout ---\n${parts.stdout}\n--- stderr ---\n${parts.stderr}\n`;
    rawPath = state.saveRaw(dir, input.tool_use_id || 'bash', body, cfg.rawOutputRetention);
  }
  const out = probeOut.changed ? compress(parts.stdout, cfg, { command, rawPath }) : probeOut;
  const err = probeErr.changed ? compress(parts.stderr, cfg, { command, rawPath }) : probeErr;

  const stats = {
    origChars: out.stats.origChars + err.stats.origChars,
    keptChars: out.text.length + err.text.length,
    origLines: out.stats.origLines + err.stats.origLines,
    keptLines: (out.changed ? out.stats.keptLines : out.stats.origLines) + (err.changed ? err.stats.keptLines : err.stats.origLines),
  };
  stats.tokensSaved = estimateTokens(Math.max(0, stats.origChars - stats.keptChars), cfg);
  state.appendEvent(dir, {
    sid: sessionId(input),
    type: 'compress',
    cmd: command.slice(0, 120),
    kind: out.changed ? out.stats.kind : err.stats.kind,
    rawPath,
    ...stats,
  });

  let updated;
  if (parts.kind === 'string') updated = out.text;
  else updated = Object.assign({}, resp, { [parts.key]: out.text, stderr: err.text });
  return hookOut('PostToolUse', { updatedToolOutput: updated });
}

// ---------------------------------------------------------------- PreToolUse(Read)

const SKIP_READ_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb|svg)$/i;
const GENERATED_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum|bun\.lockb?)$|\.min\.(js|css)$|\.(js|css)\.map$|(^|\/)(dist|build|out|\.next|coverage|node_modules|vendor|target)\//;

function fileStats(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) return null;
  if (st.size > 64 * 1024 * 1024) return { size: st.size, lines: null, longest: null, mtimeMs: st.mtimeMs };
  const buf = fs.readFileSync(file);
  let lines = 0;
  let longest = 0;
  let cur = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) {
      lines++;
      if (cur > longest) longest = cur;
      cur = 0;
    } else cur++;
  }
  if (cur > 0) {
    lines++;
    if (cur > longest) longest = cur;
  }
  return { size: st.size, lines, longest, mtimeMs: st.mtimeMs };
}

function preRead(input, cfg) {
  if (cfg.mode === 'off' || !cfg.enableReadGuard) return null;
  const ti = (input && input.tool_input) || {};
  const file = ti.file_path;
  if (typeof file !== 'string' || !file || SKIP_READ_EXT.test(file)) return null;
  const abs = path.isAbsolute(file) ? file : path.resolve(input.cwd || cfg._projectDir, file);
  let st;
  try {
    st = fileStats(abs);
  } catch (_) {
    return null; // let Read report missing files itself
  }
  if (!st) return null;
  const dir = cfg._projectDir;
  const sid = sessionId(input);
  const ranged = ti.offset != null || ti.limit != null;
  const notes = [];

  if (!ranged) {
    const prior = state.readHistory(dir, sid).filter((r) => r.path === abs && !r.ranged);
    const same = prior.find((r) => r.mtimeMs === st.mtimeMs);
    if (same) notes.push(`token-plus: ${file} was already read in full this session and is unchanged; reuse what you have unless the earlier read was compacted away.`);
  }
  state.recordRead(dir, sid, { path: abs, mtimeMs: st.mtimeMs, ranged, t: Date.now() });

  let updatedInput = null;
  const rel = path.relative(cfg._projectDir, abs) || file;
  const estTok = estimateTokens(st.size, cfg);
  if (!ranged && GENERATED_FILE.test(rel.split(path.sep).join('/')) && (st.lines || 0) > 200) {
    notes.push(`token-plus: ${rel} looks generated/vendored (${st.lines} lines, ~${estTok.toLocaleString('en-US')} tokens est.). Only read it if the task needs it; Grep for the specific entry instead.`);
  }
  if (!ranged && st.lines !== null && st.lines > cfg.largeFileWarningLines) {
    if (cfg.mode === 'strict' && cfg.readGuardMode === 'cap') {
      updatedInput = Object.assign({}, ti, { limit: cfg.largeFileWarningLines });
      notes.push(`token-plus (strict): ${rel} has ${st.lines} lines; this read was capped to lines 1-${cfg.largeFileWarningLines}. Use offset/limit for other ranges or Grep to locate code.`);
    } else {
      notes.push(`token-plus: ${rel} has ${st.lines} lines (~${estTok.toLocaleString('en-US')} tokens est.). Prefer Grep to locate the symbol, then Read with offset/limit.`);
    }
  } else if (!ranged && st.longest && st.longest > 5000) {
    notes.push(`token-plus: ${rel} has very long lines (max ${st.longest.toLocaleString('en-US')} chars, likely minified/data). Avoid reading it whole.`);
  }
  if (!notes.length && !updatedInput) return null;
  state.appendEvent(dir, { sid, type: updatedInput ? 'read-cap' : 'read-advice', file: rel.slice(0, 200), lines: st.lines, size: st.size });
  const fields = {};
  if (notes.length) fields.additionalContext = notes.join('\n');
  if (updatedInput) {
    fields.updatedInput = updatedInput;
    if (cfg.rewritePermission === 'ask' || cfg.rewritePermission === 'allow') fields.permissionDecision = cfg.rewritePermission;
  }
  return hookOut('PreToolUse', fields);
}

// ---------------------------------------------------------------- SessionStart

function readBrief(dir) {
  try {
    const text = fs.readFileSync(state.paths(dir).brief, 'utf8');
    const lines = text.split('\n');
    return lines.slice(0, 150).join('\n') + (lines.length > 150 ? '\n[token-plus: brief truncated at 150 lines]' : '');
  } catch (_) {
    return null;
  }
}

function sessionStart(input, cfg) {
  const dir = cfg._projectDir;
  const sid = sessionId(input);
  const source = (input && input.source) || 'startup';
  state.updateState(dir, (s) => {
    const now = new Date().toISOString();
    const cur = s.sessions[sid];
    if (!cur || source === 'startup' || source === 'clear') {
      s.sessions[sid] = { turns: 0, reminders: 0, lastReminderTurn: 0, sizeReminded: false, startedAt: now, updatedAt: now, source };
    } else {
      cur.updatedAt = now;
      if (source === 'compact') {
        cur.lastReminderTurn = cur.turns; // restart the interval after a compaction
        cur.sizeReminded = false;
        cur.compactions = (cur.compactions || 0) + 1;
      }
    }
    return s;
  });
  const out = {};
  if (cfg._warnings && cfg._warnings.length) {
    out.systemMessage = `token-plus config warnings: ${cfg._warnings.join('; ')}`;
  }
  if (cfg.mode === 'off') return Object.keys(out).length ? out : null;
  // Static text only: identical bytes every session keeps the cached prompt prefix stable.
  let ctx = SESSION_RULES;
  if (cfg.enableSubagentRouting) ctx += '\n' + ROUTING_RULE;
  if (cfg.loadProjectBrief) {
    const brief = readBrief(dir);
    if (brief) ctx += '\n\nProject brief (.claude/token-plus/project-brief.md):\n' + brief;
  }
  Object.assign(out, hookOut('SessionStart', { additionalContext: ctx }));
  return out;
}

// ---------------------------------------------------------------- Stop

function changedFiles(cwd) {
  try {
    const out = childProcess.execFileSync('git', ['status', '--porcelain'], {
      cwd,
      timeout: 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' }),
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
  } catch (_) {
    return [];
  }
}

function stop(input, cfg) {
  if (!input || input.stop_hook_active) return null;
  const dir = cfg._projectDir;
  const sid = sessionId(input);
  let transcriptBytes = null;
  try {
    if (input.transcript_path) transcriptBytes = fs.statSync(input.transcript_path).size;
  } catch (_) {
    /* ignore */
  }
  let reminder = null;
  state.updateState(dir, (s) => {
    const now = new Date().toISOString();
    const sess = s.sessions[sid] || (s.sessions[sid] = { turns: 0, reminders: 0, lastReminderTurn: 0, sizeReminded: false, startedAt: now });
    sess.turns = (sess.turns || 0) + 1;
    sess.updatedAt = now;
    if (transcriptBytes !== null) sess.transcriptBytes = transcriptBytes;
    if (cfg.mode === 'off') return s;
    const since = sess.turns - (sess.lastReminderTurn || 0);
    const interval = Math.max(1, cfg.compactReminderTurns);
    const bySize = transcriptBytes !== null && cfg.compactReminderChars > 0 && transcriptBytes >= cfg.compactReminderChars && !sess.sizeReminded && since >= 2;
    if ((sess.reminders || 0) < cfg.maxCompactRemindersPerSession && (since >= interval || bySize)) {
      sess.reminders = (sess.reminders || 0) + 1;
      sess.lastReminderTurn = sess.turns;
      if (bySize) sess.sizeReminded = true;
      reminder = { turns: sess.turns, n: sess.reminders, bySize };
    }
    return s;
  });
  if (!reminder) return null;
  const files = changedFiles(input.cwd || dir).slice(0, 5);
  const focus = files.length ? `Preserve current task, changed files (${files.join(', ')}), failing tests, commands run, and next steps.` : COMPACT_FOCUS;
  const size = transcriptBytes !== null ? `, transcript ~${Math.round(transcriptBytes / 1024).toLocaleString('en-US')} KB (≈${estimateTokens(transcriptBytes, cfg).toLocaleString('en-US')} tokens upper-bound est.)` : '';
  const msg =
    `token-plus: ${reminder.turns} turns this session${size}. If you are continuing the same task, consider: /compact ${focus} ` +
    `If you are switching to an unrelated task, /clear is cheaper. (reminder ${reminder.n}/${cfg.maxCompactRemindersPerSession}; tune compactReminderTurns in .claude/token-plus.json)`;
  state.appendEvent(dir, { sid, type: 'reminder', turns: reminder.turns, transcriptBytes, bySize: reminder.bySize });
  // systemMessage is shown to the user only; it does not add tokens to Claude's context.
  return { systemMessage: msg };
}

module.exports = { preBash, postBash, preRead, sessionStart, stop, SESSION_RULES, ROUTING_RULE, splitResponse };
