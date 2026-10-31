'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, PLUGIN, FAKE_HOME, tmpDir, gitRepo, runHook, fixture } = require('./helpers');

function cli(dir, ...args) {
  const r = spawnSync('node', [path.join(PLUGIN, 'scripts', 'cli.js'), ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, TOKEN_PLUS_HOME: FAKE_HOME }),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('budget sets and reports mode; invalid values rejected; hooks obey it', () => {
  const dir = gitRepo(40);
  assert.match(cli(dir, 'budget'), /mode is `normal`/);
  assert.match(cli(dir, 'budget', 'turbo'), /Unknown mode/);
  assert.match(cli(dir, 'budget', 'off'), /set to `off`/);
  const st = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'token-plus-state.json'), 'utf8'));
  assert.equal(st.mode, 'off');
  const env = { env: { CLAUDE_PROJECT_DIR: dir } };
  assert.equal(runHook('pre-bash', { session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command: 'git log' } }, env).stdout, '');
  cli(dir, 'budget', 'strict');
  const r = runHook('pre-bash', { session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command: 'git log' } }, env);
  assert.equal(r.json.hookSpecificOutput.updatedInput.command, 'git log --oneline -n 15');
});

test('status reports measured and estimated figures with clear labels', () => {
  const dir = gitRepo(40);
  const env = { env: { CLAUDE_PROJECT_DIR: dir } };
  runHook('session-start', { session_id: 's', cwd: dir, source: 'startup' }, env);
  runHook('pre-bash', { session_id: 's', cwd: dir, tool_use_id: 'a', tool_name: 'Bash', tool_input: { command: 'git log' } }, env);
  runHook('post-bash', { session_id: 's', cwd: dir, tool_use_id: 'a', tool_name: 'Bash', tool_input: { command: 'git log --oneline -n 30' }, tool_response: { stdout: 'x' } }, env);
  runHook('post-bash', { session_id: 's', cwd: dir, tool_use_id: 'b', tool_name: 'Bash', tool_input: { command: 'pytest' }, tool_response: { stdout: fixture('pytest_fail.txt'), stderr: '' } }, env);
  runHook('stop', { session_id: 's', cwd: dir }, env);
  const out = cli(dir, 'status');
  assert.match(out, /mode: `normal`/);
  assert.match(out, /turns monitored \| 1 \/ 1/);
  assert.match(out, /Commands rewritten \(proposed \/ confirmed applied\) \| 1 \/ 1/);
  assert.match(out, /Outputs compressed \| 1/);
  assert.match(out, /Estimated tokens saved by compression\*\* \| \*\*~[\d,]+\*\*/);
  assert.match(out, /not billing data/);
  assert.match(out, /git-log-limit ×1/);
});

test('raw lists saved outputs; reset clears telemetry only', () => {
  const dir = tmpDir();
  const env = { env: { CLAUDE_PROJECT_DIR: dir } };
  assert.match(cli(dir, 'raw'), /No saved raw outputs/);
  runHook('post-bash', { session_id: 's', cwd: dir, tool_use_id: 'q', tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_response: { stdout: fixture('npm_install.txt'), stderr: '' } }, env);
  assert.match(cli(dir, 'raw'), /\.claude\/token-plus\/raw\/.*q\.log/);
  cli(dir, 'budget', 'strict');
  assert.match(cli(dir, 'reset'), /telemetry reset/);
  assert.match(cli(dir, 'status'), /Outputs compressed \| 0/);
  assert.match(cli(dir, 'status'), /mode: `strict`/);
});

test('raw log retention rotates old files', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify({ rawOutputRetention: 2 }));
  const env = { env: { CLAUDE_PROJECT_DIR: dir } };
  for (const id of ['r1', 'r2', 'r3']) {
    runHook('post-bash', { session_id: 's', cwd: dir, tool_use_id: id, tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_response: { stdout: fixture('npm_install.txt'), stderr: '' } }, env);
  }
  const files = fs.readdirSync(path.join(dir, '.claude', 'token-plus', 'raw'));
  assert.equal(files.length, 2);
  assert.ok(!files.some((f) => f.endsWith('r1.log')));
});

test('init writes defaults once and never overwrites', () => {
  const dir = tmpDir();
  assert.match(cli(dir, 'init'), /Wrote/);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'token-plus.json'), 'utf8'));
  assert.equal(cfg.maxToolOutputLines, 150);
  assert.deepEqual(cfg.protectedPaths, ['.env', '.env.*', 'secrets', 'credentials', '*.pem', '*.key']);
  assert.match(cli(dir, 'init'), /already exists/);
});

test('audit reports MCP usage, CLAUDE.md size and recommendations without modifying config', () => {
  const dir = tmpDir();
  const home = tmpDir('tp-audit-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const claudeJson = { mcpServers: { github: { command: 'x' }, unusedsrv: { command: 'y' } } };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(claudeJson));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Rule line with plenty of words in it.\n'.repeat(400));
  const tdir = path.join(home, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, 'a.jsonl'), '{"type":"tool_use","name":"mcp__github__get_issue"}\n'.repeat(3));
  const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
  const r = spawnSync('node', [path.join(PLUGIN, 'scripts', 'cli.js'), 'audit'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, TOKEN_PLUS_HOME: home }),
  });
  const out = r.stdout;
  assert.match(out, /`github` \(user\) — 3 tool calls seen/);
  assert.match(out, /`unusedsrv` \(user\) — \*\*no calls seen\*\*/);
  assert.match(out, /MCP server `unusedsrv` shows no recent use/);
  assert.match(out, /CLAUDE\.md` is ~[\d,]+ tokens/);
  assert.match(out, /read-only/);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), before);
});

test('plugin layout validates', () => {
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'validate-plugin.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('every JSON file in the repo parses', () => {
  const files = [
    '.claude-plugin/marketplace.json',
    'plugins/token-plus/.claude-plugin/plugin.json',
    'plugins/token-plus/hooks/hooks.json',
    'plugins/token-plus/config/token-plus.default.json',
    '.claude/token-plus.json',
  ];
  for (const f of files) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
});

test('shipped default config equals built-in defaults', () => {
  const { DEFAULTS } = require(path.join(PLUGIN, 'lib', 'config.js'));
  const shipped = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'config', 'token-plus.default.json'), 'utf8'));
  assert.deepEqual(shipped, JSON.parse(JSON.stringify(DEFAULTS)));
});
