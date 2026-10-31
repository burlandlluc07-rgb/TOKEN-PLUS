'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'token-plus');
const FIXTURES = path.join(__dirname, 'fixtures');

// Isolate from the developer's real ~/.claude
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-home-'));
process.env.TOKEN_PLUS_HOME = FAKE_HOME;
delete process.env.TOKEN_PLUS_MODE;
delete process.env.CLAUDE_PROJECT_DIR;

const { loadConfig } = require(path.join(PLUGIN, 'lib', 'config.js'));

function tmpDir(prefix = 'tp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cfgFor(dir, overrides = {}, mode) {
  if (Object.keys(overrides).length) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'token-plus.json'), JSON.stringify(overrides));
  }
  return loadConfig({ cwd: dir }, { stateMode: mode });
}

function git(dir, ...args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    }),
  });
}

function gitRepo(commits = 3) {
  const dir = tmpDir('tp-repo-');
  git(dir, 'init', '-q');
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(dir, 'file.txt'), `v${i}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', `commit ${i}`);
  }
  return dir;
}

function runHook(name, input, opts = {}) {
  const env = Object.assign({}, process.env, { TOKEN_PLUS_HOME: FAKE_HOME }, opts.env || {});
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  const r = spawnSync(opts.shell || 'sh', [path.join(PLUGIN, 'hooks', 'run.sh'), name], {
    input: stdin,
    env,
    encoding: 'utf8',
    cwd: opts.cwd || (input && input.cwd) || process.cwd(),
    timeout: 20000,
  });
  let json = null;
  if (r.stdout && r.stdout.trim()) json = JSON.parse(r.stdout);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

module.exports = { ROOT, PLUGIN, FAKE_HOME, tmpDir, cfgFor, git, gitRepo, runHook, fixture };
