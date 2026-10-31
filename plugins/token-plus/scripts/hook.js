#!/usr/bin/env node
'use strict';
// Single entrypoint for all token-plus hooks:  node hook.js <pre-bash|post-bash|pre-read|session-start|stop>
// Contract: on ANY failure (bad stdin, exception, timeout) print nothing and exit 0,
// which Claude Code treats as "no opinion" -> the tool call proceeds unchanged.

const path = require('path');

const HANDLERS = {
  'pre-bash': 'preBash',
  'post-bash': 'postBash',
  'pre-read': 'preRead',
  'session-start': 'sessionStart',
  stop: 'stop',
};

const STDIN_TIMEOUT_MS = 3000;
const MAX_STDIN = 64 * 1024 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) {
        clearTimeout(timer);
        finish(null);
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

async function main() {
  const which = process.argv[2];
  const fnName = HANDLERS[which];
  if (!fnName) return;
  const raw = await readStdin();
  if (!raw) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    return;
  }
  if (!input || typeof input !== 'object') return;

  let projectDir = process.cwd();
  try {
    const { loadConfig, projectDir: pd } = require(path.join(__dirname, '..', 'lib', 'config.js'));
    const state = require(path.join(__dirname, '..', 'lib', 'state.js'));
    projectDir = pd(input);
    const st = state.readState(projectDir);
    const cfg = loadConfig(input, { stateMode: st.mode });
    const hooks = require(path.join(__dirname, '..', 'lib', 'hooks.js'));
    const result = hooks[fnName](input, cfg);
    if (result) process.stdout.write(JSON.stringify(result));
  } catch (err) {
    try {
      const state = require(path.join(__dirname, '..', 'lib', 'state.js'));
      state.appendEvent(projectDir, {
        sid: input.session_id || 'unknown',
        type: 'hook-error',
        hook: which,
        error: String((err && err.message) || err).slice(0, 300),
      });
    } catch (_) {
      /* ignore */
    }
  }
}

main()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0;
  });
