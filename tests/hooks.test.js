'use strict';
// Integration tests: run the real hook launcher (hooks/run.sh -> scripts/hook.js) with JSON on stdin,
// exactly as Claude Code does, and validate the emitted hook JSON.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PLUGIN, tmpDir, gitRepo, runHook, fixture } = require('./helpers');
const { SESSION_RULES } = require(path.join(PLUGIN, 'lib', 'hooks.js'));

const base = (dir, extra) => Object.assign({ session_id: 'sess-1', transcript_path: path.join(dir, 't.jsonl'), cwd: dir, permission_mode: 'default' }, extra);
const env = (dir, more = {}) => ({ env: Object.assign({ CLAUDE_PROJECT_DIR: dir }, more) });

function events(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.claude', 'token-plus', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------- PreToolUse Bash
test('pre-bash emits valid PreToolUse JSON with updatedInput preserving other fields', () => {
  const dir = gitRepo(40);
  const r = runHook('pre-bash', base(dir, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'git log', description: 'show log', timeout: 5000 } }), env(dir));
  assert.equal(r.status, 0);
  const h = r.json.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.deepEqual(h.updatedInput, { command: 'git log --oneline -n 30', description: 'show log', timeout: 5000 });
  assert.equal(h.permissionDecision, undefined, 'default mode must not bypass permissions');
  assert.match(h.permissionDecisionReason, /^token-plus: /);
  const ev = events(dir).find((e) => e.type === 'rewrite');
  assert.equal(ev.original, 'git log');
  assert.equal(ev.rewritten, 'git log --oneline -n 30');
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'token-plus', 'pending', 'tu1.json')));
});

test('pre-bash honours rewritePermission=ask', () => {
  const dir = gitRepo(1);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify({ rewritePermission: 'ask' }));
  const r = runHook('pre-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'git status' } }), env(dir));
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
});

test('pre-bash prints nothing for untouched commands', () => {
  const dir = tmpDir();
  const r = runHook('pre-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }), env(dir));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('pre-bash advisory for large cat adds context only', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x\n'.repeat(5000));
  const r = runHook('pre-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'cat big.txt' } }), env(dir));
  const h = r.json.hookSpecificOutput;
  assert.equal(h.updatedInput, undefined);
  assert.match(h.additionalContext, /5000 lines/);
});

// ---------------------------------------------------------------- graceful degradation
test('malformed stdin, empty stdin and unknown hook names exit 0 silently', () => {
  const dir = tmpDir();
  for (const [name, input] of [['pre-bash', '{not json'], ['post-bash', ''], ['stop', 'null'], ['bogus', '{}']]) {
    const r = runHook(name, input, Object.assign({ cwd: dir }, env(dir)));
    assert.equal(r.status, 0, name);
    assert.equal(r.stdout, '', name);
  }
});

test('missing node degrades to pass-through', () => {
  const dir = tmpDir();
  const r = runHook('pre-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'git log' } }), { cwd: dir, shell: '/bin/sh', env: { PATH: '/nonexistent', CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('TOKEN_PLUS_DISABLE=1 disables every hook', () => {
  const dir = gitRepo(40);
  const r = runHook('pre-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'git log' } }), env(dir, { TOKEN_PLUS_DISABLE: '1' }));
  assert.equal(r.stdout, '');
});

test('hook crash is logged and passes through', () => {
  const dir = tmpDir();
  // tool_input that makes handlers misbehave: a Proxy-like oddity is impossible in JSON, so force an
  // unwritable project dir for state and an invalid transcript to exercise error paths.
  const r = runHook('post-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: 5 } }), env(dir));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// ---------------------------------------------------------------- PostToolUse Bash
test('post-bash compresses large stdout via updatedToolOutput, keeps shape, saves raw log', () => {
  const dir = tmpDir();
  const stdout = fixture('pytest_fail.txt');
  const resp = { stdout, stderr: 'warn: something\n', interrupted: false, isImage: false };
  const r = runHook('post-bash', base(dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu9', tool_input: { command: 'pytest' }, tool_response: resp }), env(dir));
  assert.equal(r.status, 0);
  const h = r.json.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PostToolUse');
  const u = h.updatedToolOutput;
  assert.deepEqual(Object.keys(u).sort(), ['interrupted', 'isImage', 'stderr', 'stdout']);
  assert.equal(u.interrupted, false);
  assert.equal(u.isImage, false);
  assert.equal(u.stderr, 'warn: something\n');
  assert.ok(u.stdout.length < stdout.length / 3);
  assert.match(u.stdout, /2 failed, 298 passed/);
  const m = /full output: (\S+)\]$/.exec(u.stdout);
  assert.ok(m, 'footer references raw log');
  const raw = fs.readFileSync(path.join(dir, m[1]), 'utf8');
  assert.ok(raw.includes(stdout), 'raw log holds the full original');
  const ev = events(dir).find((e) => e.type === 'compress');
  assert.ok(ev.origChars > ev.keptChars);
  assert.ok(ev.tokensSaved > 0);
});

test('post-bash leaves small output, images and string responses alone', () => {
  const dir = tmpDir();
  const mk = (resp) => runHook('post-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: resp }), env(dir));
  assert.equal(mk({ stdout: 'a\nb\n', stderr: '', interrupted: false, isImage: false }).stdout, '');
  assert.equal(mk({ stdout: 'x'.repeat(100000), isImage: true }).stdout, '');
  const s = mk('y\n'.repeat(5000) + 'Error: boom\n');
  assert.equal(typeof s.json.hookSpecificOutput.updatedToolOutput, 'string');
});

test('post-bash never alters or persists output of commands touching protected paths', () => {
  const dir = tmpDir();
  const r = runHook('post-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'cat .env.production' }, tool_response: { stdout: 'SECRET=1\n'.repeat(5000), stderr: '' } }), env(dir));
  assert.equal(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'token-plus', 'raw')));
});

test('post-bash respects TP_RAW=1 and off mode', () => {
  const dir = tmpDir();
  const big = { stdout: 'line\n'.repeat(5000) + 'x'.repeat(3000), stderr: '' };
  assert.equal(runHook('post-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'TP_RAW=1 cat big' }, tool_response: big }), env(dir)).stdout, '');
  assert.equal(runHook('post-bash', base(dir, { tool_name: 'Bash', tool_input: { command: 'cat big' }, tool_response: big }), env(dir, { TOKEN_PLUS_MODE: 'off' })).stdout, '');
});

test('post-bash confirms whether a rewrite was actually applied', () => {
  const dir = gitRepo(40);
  runHook('pre-bash', base(dir, { tool_name: 'Bash', tool_use_id: 'A', tool_input: { command: 'git log' } }), env(dir));
  runHook('post-bash', base(dir, { tool_name: 'Bash', tool_use_id: 'A', tool_input: { command: 'git log --oneline -n 30' }, tool_response: { stdout: 'ok' } }), env(dir));
  runHook('pre-bash', base(dir, { tool_name: 'Bash', tool_use_id: 'B', tool_input: { command: 'git status' } }), env(dir));
  runHook('post-bash', base(dir, { tool_name: 'Bash', tool_use_id: 'B', tool_input: { command: 'git status' }, tool_response: { stdout: 'ok' } }), env(dir));
  const res = events(dir).filter((e) => e.type === 'rewrite-result');
  assert.deepEqual(res.map((e) => e.applied), [true, false]);
});

// ---------------------------------------------------------------- PreToolUse Read
test('read guard: large file advisory, never blocks', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'big.py');
  fs.writeFileSync(f, 'print(1)\n'.repeat(4000));
  const r = runHook('pre-read', base(dir, { tool_name: 'Read', tool_input: { file_path: f } }), env(dir));
  const h = r.json.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(h.permissionDecision, undefined);
  assert.equal(h.updatedInput, undefined);
  assert.match(h.additionalContext, /4000 lines/);
});

test('read guard: ranged reads and small files pass silently; repeated full read is flagged', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'small.py');
  fs.writeFileSync(f, 'x = 1\n');
  const first = runHook('pre-read', base(dir, { tool_name: 'Read', tool_input: { file_path: f } }), env(dir));
  assert.equal(first.stdout, '');
  const ranged = runHook('pre-read', base(dir, { tool_name: 'Read', tool_input: { file_path: f, offset: 1, limit: 10 } }), env(dir));
  assert.equal(ranged.stdout, '');
  const again = runHook('pre-read', base(dir, { tool_name: 'Read', tool_input: { file_path: f } }), env(dir));
  assert.match(again.json.hookSpecificOutput.additionalContext, /already read in full this session and is unchanged/);
  fs.writeFileSync(f, 'x = 2\n');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(f, t, t);
  const changed = runHook('pre-read', base(dir, { tool_name: 'Read', tool_input: { file_path: f } }), env(dir));
  assert.equal(changed.stdout, '');
});

test('read guard: strict mode caps unranged large reads with limit', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'big.ts');
  fs.writeFileSync(f, 'let a = 1;\n'.repeat(3000));
  const r = runHook('pre-read', base(dir, { tool_name: 'Read', tool_input: { file_path: f } }), env(dir, { TOKEN_PLUS_MODE: 'strict' }));
  const h = r.json.hookSpecificOutput;
  assert.deepEqual(h.updatedInput, { file_path: f, limit: 1000 });
  assert.match(h.additionalContext, /capped to lines 1-1000/);
});

test('read guard: lockfiles flagged; missing files and images ignored', () => {
  const dir = tmpDir();
  const lock = path.join(dir, 'package-lock.json');
  fs.writeFileSync(lock, '{\n'.repeat(500));
  assert.match(runHook('pre-read', base(dir, { tool_name: 'Read', tool_input: { file_path: lock } }), env(dir)).json.hookSpecificOutput.additionalContext, /generated\/vendored/);
  assert.equal(runHook('pre-read', base(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'nope.txt') } }), env(dir)).stdout, '');
  const img = path.join(dir, 'a.png');
  fs.writeFileSync(img, Buffer.alloc(100000));
  assert.equal(runHook('pre-read', base(dir, { tool_name: 'Read', tool_input: { file_path: img } }), env(dir)).stdout, '');
});

// ---------------------------------------------------------------- SessionStart
test('session rules are under 120 words and cover the required points', () => {
  const words = SESSION_RULES.split(/\s+/).filter(Boolean).length;
  assert.ok(words < 120, `${words} words`);
  for (const k of [/relevant line range/, /echo/, /re-read/, /CLI tools over equivalent MCP/, /subagent/, /ambiguous, ask/, /Grep\/Glob/]) assert.match(SESSION_RULES, k);
});

test('session-start output is byte-identical across sessions (cache-stable prefix)', () => {
  const dir = tmpDir();
  const a = runHook('session-start', base(dir, { hook_event_name: 'SessionStart', source: 'startup' }), env(dir));
  const b = runHook('session-start', base(dir, { hook_event_name: 'SessionStart', source: 'startup', session_id: 'other' }), env(dir));
  assert.equal(a.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.json.hookSpecificOutput.additionalContext, SESSION_RULES);
});

test('session-start: brief only when enabled, routing hint only when enabled, nothing in off mode', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.claude', 'token-plus'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus', 'project-brief.md'), '# Brief\n' + 'line\n'.repeat(200));
  const plain = runHook('session-start', base(dir, { source: 'startup' }), env(dir));
  assert.doesNotMatch(plain.json.hookSpecificOutput.additionalContext, /Project brief/);
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify({ loadProjectBrief: true, enableSubagentRouting: true }));
  const ctx = runHook('session-start', base(dir, { source: 'startup' }), env(dir)).json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Project brief/);
  assert.match(ctx, /brief truncated at 150 lines/);
  assert.match(ctx, /quick-reader/);
  assert.equal(runHook('session-start', base(dir, { source: 'startup' }), env(dir, { TOKEN_PLUS_MODE: 'off' })).stdout, '');
});

test('session-start surfaces config warnings to the user only', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify({ mode: 'turbo', bogus: 1 }));
  const r = runHook('session-start', base(dir, { source: 'startup' }), env(dir));
  assert.match(r.json.systemMessage, /unknown key "bogus"/);
  assert.match(r.json.systemMessage, /"mode" must be one of/);
});

// ---------------------------------------------------------------- Stop
test('stop: reminder every N turns, capped, via systemMessage only', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify({ compactReminderTurns: 3, maxCompactRemindersPerSession: 2 }));
  fs.writeFileSync(path.join(dir, 't.jsonl'), 'x'.repeat(4096));
  runHook('session-start', base(dir, { source: 'startup' }), env(dir));
  const outs = [];
  for (let i = 0; i < 12; i++) outs.push(runHook('stop', base(dir, { hook_event_name: 'Stop', stop_hook_active: false }), env(dir)));
  const reminded = outs.map((o, i) => (o.stdout ? i + 1 : null)).filter(Boolean);
  assert.deepEqual(reminded, [3, 6]);
  const msg = outs[2].json;
  assert.deepEqual(Object.keys(msg), ['systemMessage']);
  assert.match(msg.systemMessage, /\/compact Preserve current task, changed files, failing tests, commands run, and next steps\./);
  assert.match(msg.systemMessage, /\/clear/);
  assert.match(msg.systemMessage, /reminder 1\/2/);
  const st = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'token-plus-state.json'), 'utf8'));
  assert.equal(st.sessions['sess-1'].turns, 12);
});

test('stop: names changed files in the compact focus', () => {
  const dir = gitRepo(1);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify({ compactReminderTurns: 1 }));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'changed\n');
  const r = runHook('stop', base(dir, {}), env(dir));
  assert.match(r.json.systemMessage, /changed files \(.*file\.txt.*\)/);
});

test('stop: size-based reminder fires once before the turn interval', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify({ compactReminderTurns: 50, compactReminderChars: 1000 }));
  fs.writeFileSync(path.join(dir, 't.jsonl'), 'x'.repeat(5000));
  const outs = [1, 2, 3, 4].map(() => runHook('stop', base(dir, {}), env(dir)).stdout !== '');
  assert.deepEqual(outs, [false, true, false, false]);
});

test('stop: silent when stop_hook_active or mode off', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify({ compactReminderTurns: 1 }));
  assert.equal(runHook('stop', base(dir, { stop_hook_active: true }), env(dir)).stdout, '');
  assert.equal(runHook('stop', base(dir, {}), env(dir, { TOKEN_PLUS_MODE: 'off' })).stdout, '');
});

test('compaction restarts the reminder interval', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify({ compactReminderTurns: 3 }));
  runHook('session-start', base(dir, { source: 'startup' }), env(dir));
  runHook('stop', base(dir, {}), env(dir));
  runHook('stop', base(dir, {}), env(dir));
  runHook('session-start', base(dir, { source: 'compact' }), env(dir));
  const r = [1, 2, 3].map(() => runHook('stop', base(dir, {}), env(dir)).stdout !== '');
  assert.deepEqual(r, [false, false, true]);
});
