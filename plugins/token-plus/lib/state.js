'use strict';
// Local state for token-plus. Everything lives under the project's .claude/ directory:
//   .claude/token-plus-state.json      mode override + per-session counters (small, atomic writes)
//   .claude/token-plus/events.jsonl    append-only telemetry (rewrites, compressions, failures)
//   .claude/token-plus/raw/            full original outputs of compressed commands (reversibility)
//   .claude/token-plus/pending/        rewrite records awaiting PostToolUse confirmation
//   .claude/token-plus/sessions/       per-session read history (re-read detection)
// All functions swallow I/O errors: state is best-effort and must never break a session.

const fs = require('fs');
const path = require('path');

const MAX_EVENTS_BYTES = 5 * 1024 * 1024;
const MAX_SESSIONS_KEPT = 50;

function paths(projectDir) {
  const claudeDir = path.join(projectDir, '.claude');
  const dataDir = path.join(claudeDir, 'token-plus');
  return {
    claudeDir,
    dataDir,
    state: path.join(claudeDir, 'token-plus-state.json'),
    events: path.join(dataDir, 'events.jsonl'),
    raw: path.join(dataDir, 'raw'),
    pending: path.join(dataDir, 'pending'),
    sessions: path.join(dataDir, 'sessions'),
    brief: path.join(dataDir, 'project-brief.md'),
    lock: path.join(dataDir, '.state.lock'),
  };
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

function safeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

function emptyState() {
  return { version: 1, mode: null, sessions: {} };
}

function readState(projectDir) {
  try {
    const s = JSON.parse(fs.readFileSync(paths(projectDir).state, 'utf8'));
    if (!s || typeof s !== 'object') return emptyState();
    if (!s.sessions || typeof s.sessions !== 'object') s.sessions = {};
    return s;
  } catch (_) {
    return emptyState();
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    /* ignore */
  }
}

// Run fn(state) -> state under a coarse mkdir lock; atomic write via rename.
function updateState(projectDir, fn) {
  const p = paths(projectDir);
  if (!ensureDir(p.dataDir)) return null;
  let locked = false;
  for (let i = 0; i < 40; i++) {
    try {
      fs.mkdirSync(p.lock);
      locked = true;
      break;
    } catch (e) {
      try {
        const age = Date.now() - fs.statSync(p.lock).mtimeMs;
        if (age > 5000) fs.rmdirSync(p.lock);
      } catch (_) {
        /* ignore */
      }
      sleepSync(25);
    }
  }
  try {
    const state = readState(projectDir);
    const next = fn(state) || state;
    pruneSessions(next);
    const tmp = `${p.state}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, p.state);
    return next;
  } catch (_) {
    return null;
  } finally {
    if (locked) {
      try {
        fs.rmdirSync(p.lock);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function pruneSessions(state) {
  const ids = Object.keys(state.sessions || {});
  if (ids.length <= MAX_SESSIONS_KEPT) return;
  ids
    .sort((a, b) => (state.sessions[a].updatedAt || '').localeCompare(state.sessions[b].updatedAt || ''))
    .slice(0, ids.length - MAX_SESSIONS_KEPT)
    .forEach((id) => delete state.sessions[id]);
}

function appendEvent(projectDir, event) {
  const p = paths(projectDir);
  if (!ensureDir(p.dataDir)) return;
  try {
    try {
      if (fs.statSync(p.events).size > MAX_EVENTS_BYTES) {
        fs.renameSync(p.events, `${p.events}.1`);
      }
    } catch (_) {
      /* no file yet */
    }
    const line = JSON.stringify(Object.assign({ t: new Date().toISOString() }, event)) + '\n';
    fs.appendFileSync(p.events, line);
  } catch (_) {
    /* ignore */
  }
}

function readEvents(projectDir) {
  const p = paths(projectDir);
  const out = [];
  for (const f of [`${p.events}.1`, p.events]) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch (_) {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (_) {
        /* skip corrupt line */
      }
    }
  }
  return out;
}

function writePending(projectDir, toolUseId, record) {
  if (!toolUseId) return;
  const p = paths(projectDir);
  if (!ensureDir(p.pending)) return;
  try {
    fs.writeFileSync(path.join(p.pending, `${safeId(toolUseId)}.json`), JSON.stringify(record));
  } catch (_) {
    /* ignore */
  }
}

function takePending(projectDir, toolUseId) {
  if (!toolUseId) return null;
  const f = path.join(paths(projectDir).pending, `${safeId(toolUseId)}.json`);
  try {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.unlinkSync(f);
    return rec;
  } catch (_) {
    return null;
  }
}

// Save full original output so compression is reversible. Returns project-relative path or null.
function saveRaw(projectDir, id, text, retention) {
  const p = paths(projectDir);
  if (!ensureDir(p.raw)) return null;
  try {
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeId(id)}.log`;
    const file = path.join(p.raw, name);
    fs.writeFileSync(file, text, { mode: 0o600 });
    rotateRaw(p.raw, retention);
    return path.relative(projectDir, file);
  } catch (_) {
    return null;
  }
}

function rotateRaw(dir, retention) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    const excess = files.length - Math.max(1, retention || 30);
    for (let i = 0; i < excess; i++) fs.unlinkSync(path.join(dir, files[i]));
  } catch (_) {
    /* ignore */
  }
}

function listRaw(projectDir) {
  try {
    const dir = paths(projectDir).raw;
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch (_) {
    return [];
  }
}

function recordRead(projectDir, sessionId, rec) {
  const p = paths(projectDir);
  if (!ensureDir(p.sessions)) return;
  try {
    fs.appendFileSync(path.join(p.sessions, `${safeId(sessionId)}.reads.jsonl`), JSON.stringify(rec) + '\n');
  } catch (_) {
    /* ignore */
  }
}

function readHistory(projectDir, sessionId) {
  try {
    return fs
      .readFileSync(path.join(paths(projectDir).sessions, `${safeId(sessionId)}.reads.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = {
  paths,
  ensureDir,
  readState,
  updateState,
  appendEvent,
  readEvents,
  writePending,
  takePending,
  saveRaw,
  listRaw,
  recordRead,
  readHistory,
  safeId,
};
