'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PLUGIN, tmpDir, cfgFor, git, gitRepo } = require('./helpers');
const { sanitizeCommand, isProtected } = require(path.join(PLUGIN, 'lib', 'sanitizer.js'));

const repo = gitRepo(45);
const normal = cfgFor(tmpDir());
const strict = cfgFor(tmpDir(), {}, 'strict');
const off = cfgFor(tmpDir(), {}, 'off');
const S = (cmd, cfg = normal, cwd = repo) => sanitizeCommand(cmd, cfg, { cwd });

// ---------------------------------------------------------------- git status
test('git status → --short --branch', () => {
  const r = S('git status');
  assert.equal(r.changed, true);
  assert.equal(r.command, 'git status --short --branch');
  assert.equal(r.rule, 'git-status-short');
});

test('git status with explicit flags is untouched', () => {
  assert.equal(S('git status --porcelain').changed, false);
  assert.equal(S('git status -s').changed, false);
});

test('git status with pathspec keeps pathspec', () => {
  assert.equal(S('git status src').command, 'git status --short --branch src');
});

test('git status during a merge is untouched (long form explains merge state)', () => {
  const r = gitRepo(1);
  fs.writeFileSync(path.join(r, '.git', 'MERGE_HEAD'), 'deadbeef\n');
  const res = sanitizeCommand('git status', normal, { cwd: r });
  assert.equal(res.changed, false);
  assert.match(res.skipped, /in progress/);
});

test('git status outside a repo is untouched', () => {
  assert.equal(sanitizeCommand('git status', normal, { cwd: tmpDir() }).changed, false);
});

test('git -C dir status works with global option', () => {
  const parent = path.dirname(repo);
  const r = sanitizeCommand(`git -C ${path.basename(repo)} status`, normal, { cwd: parent });
  assert.equal(r.command, `git -C ${path.basename(repo)} status --short --branch`);
});

// ---------------------------------------------------------------- git log
test('unbounded git log → --oneline -n 30 with estimate', () => {
  const r = S('git log');
  assert.equal(r.command, 'git log --oneline -n 30');
  assert.ok(r.estimate && r.estimate.lines > 0);
  assert.match(r.note, /TP_RAW=1/);
});

test('strict git log limit is 15', () => {
  assert.equal(S('git log', strict).command, 'git log --oneline -n 15');
});

test('git log with format keeps format, only adds -n', () => {
  assert.equal(S('git log -p').command, 'git log -n 30 -p');
  assert.equal(S(`git log --format='%h %an'`).command, `git log -n 30 --format='%h %an'`);
});

test('git log already limited / searching / ranged is untouched', () => {
  for (const c of ['git log -n 5', 'git log -5', 'git log --max-count=3', 'git log -n5', 'git log --grep=fix', 'git log -S foo', 'git log --author=me', 'git log main..feature', 'git log --reverse', 'git log --all', 'git log -- src']) {
    assert.equal(S(c).changed, false, c);
  }
});

test('git log in a short history is untouched', () => {
  const small = gitRepo(3);
  const r = sanitizeCommand('git log', normal, { cwd: small });
  assert.equal(r.changed, false);
  assert.match(r.skipped, /only 3 commits/);
});

test('git log with unknown flag is untouched', () => {
  assert.equal(S('git log --walk-reflogs').changed, false);
});

test('cd prefix is preserved', () => {
  const parent = path.dirname(repo);
  const r = sanitizeCommand(`cd ${path.basename(repo)} && git log`, normal, { cwd: parent });
  assert.equal(r.command, `cd ${path.basename(repo)} && git log --oneline -n 30`);
});

// ---------------------------------------------------------------- git diff
test('git diff excludes changed lockfiles with measured estimate', () => {
  const r = gitRepo(1);
  fs.writeFileSync(path.join(r, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(r, 'app.js'), 'a\n');
  git(r, 'add', '.');
  git(r, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(r, 'package-lock.json'), Array.from({ length: 500 }, (_, i) => `"l${i}"`).join('\n'));
  fs.writeFileSync(path.join(r, 'app.js'), 'b\n');
  const res = sanitizeCommand('git diff', normal, { cwd: r });
  assert.equal(res.changed, true);
  assert.equal(res.command, `git diff -- :/ ':(top,exclude)package-lock.json'`);
  assert.ok(res.estimate.lines >= 500);
  // the rewritten command must actually run and still show app.js
  const out = require('child_process').execSync(res.command, { cwd: r, encoding: 'utf8' });
  assert.match(out, /app\.js/);
  assert.doesNotMatch(out, /package-lock/);
});

test('git diff without generated files is untouched in normal, -U1 in strict', () => {
  const r = gitRepo(1);
  fs.writeFileSync(path.join(r, 'file.txt'), 'changed\n');
  assert.equal(sanitizeCommand('git diff', normal, { cwd: r }).changed, false);
  assert.equal(sanitizeCommand('git diff', strict, { cwd: r }).command, 'git diff --unified=1');
});

test('git diff with paths, stat or ambiguous args is untouched', () => {
  for (const c of ['git diff -- src', 'git diff --stat', 'git diff --name-only', 'git diff file.txt', 'git diff somebranchname', 'git diff --no-index a b']) {
    assert.equal(S(c).changed, false, c);
  }
});

// ---------------------------------------------------------------- find
test('find listing gets -maxdepth and vendored excludes', () => {
  assert.equal(S('find .').command, `find . -maxdepth 6 -not -path '*/node_modules/*' -not -path '*/.git/*'`);
  assert.equal(S('find src -type f').command, `find src -maxdepth 6 -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`);
  assert.equal(S('find . -type f', strict).command, `find . -maxdepth 4 -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`);
});

test('find inside node_modules gets depth only', () => {
  assert.equal(S('find node_modules -type d').command, 'find node_modules -maxdepth 6 -type d');
});

test('find searches, actions and explicit limits are untouched', () => {
  for (const c of ['find . -name "*.ts"', 'find . -maxdepth 2', 'find . -type f -delete', 'find . -exec cat {} +', 'find . -type f -o -type d', 'find . ! -name x', 'find . -newer x']) {
    assert.equal(S(c).changed, false, c);
  }
});

// ---------------------------------------------------------------- grep
test('recursive grep excludes existing vendored dirs only', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.mkdirSync(path.join(d, '.git'));
  const r = sanitizeCommand('grep -rn "TODO" .', normal, { cwd: d });
  assert.equal(r.command, 'grep --exclude-dir=.git --exclude-dir=node_modules -rn "TODO" .');
});

test('grep without recursion, with include filters, or no vendored dirs is untouched', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'node_modules'));
  assert.equal(sanitizeCommand('grep TODO file.txt', normal, { cwd: d }).changed, false);
  assert.equal(sanitizeCommand('grep -r --include=*.js TODO .', normal, { cwd: d }).changed, false);
  assert.equal(sanitizeCommand('grep -r TODO .', normal, { cwd: tmpDir() }).changed, false);
  assert.equal(sanitizeCommand('grep -r TODO node_modules', normal, { cwd: d }).changed, false);
});

// ---------------------------------------------------------------- cat
test('cat on large file: advisory in normal, head in strict', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'big.log'), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'));
  const n = sanitizeCommand('cat big.log', normal, { cwd: d });
  assert.equal(n.changed, false);
  assert.equal(n.advisory, true);
  assert.match(n.note, /3000 lines/);
  const s = sanitizeCommand('cat big.log', strict, { cwd: d });
  assert.equal(s.changed, true);
  assert.match(s.command, /^head -n 80 -- big\.log && echo '\[token-plus: showed lines 1-80 of 3000/);
  const out = require('child_process').execSync(s.command, { cwd: d, encoding: 'utf8', shell: '/bin/sh' });
  assert.equal(out.trim().split('\n').length, 81);
});

test('cat on small file, multiple files or flags is untouched', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'small.txt'), 'hi\n');
  assert.equal(sanitizeCommand('cat small.txt', strict, { cwd: d }).changed, false);
  assert.equal(sanitizeCommand('cat a b', strict, { cwd: d }).changed, false);
  assert.equal(sanitizeCommand('cat -n small.txt', strict, { cwd: d }).changed, false);
});

// ---------------------------------------------------------------- installers / runners
test('package installs and test runners get quieter, non-hiding flags', () => {
  const d = tmpDir();
  const C = (c, cfg = normal) => sanitizeCommand(c, cfg, { cwd: d });
  assert.equal(C('npm install').command, 'npm install --no-fund');
  assert.equal(C('npm ci').command, 'npm ci --no-fund');
  assert.equal(C('pip install -r requirements.txt').command, 'pip install --progress-bar=off --disable-pip-version-check -r requirements.txt');
  assert.equal(C('python3 -m pip install requests').command, 'python3 -m pip install --progress-bar=off --disable-pip-version-check requests');
  assert.equal(C('pytest tests/').command, 'pytest -q tests/');
  assert.equal(C('python -m pytest -x').command, 'python -m pytest -q -x');
  assert.equal(C('pytest', strict).command, 'pytest -q --tb=short');
  assert.equal(C('cargo test').command, 'cargo test -q');
  assert.equal(C('cargo test -- --nocapture').command, 'cargo test -q -- --nocapture');
  assert.equal(C('./gradlew build').command, './gradlew --console=plain build');
  assert.equal(C('tree').command, `tree -L 3 -I 'node_modules|.git|__pycache__|.venv|dist|build|target'`);
  assert.equal(C('docker logs web').command, 'docker logs --tail 200 web');
  assert.equal(C('journalctl -u nginx').command, 'journalctl -n 200 --no-pager -u nginx');
});

test('runners with explicit verbosity are untouched', () => {
  const d = tmpDir();
  for (const c of ['pytest -v', 'pytest -q', 'npm install --verbose', 'pip install -v x', 'cargo build -v', 'docker logs --tail 5 web', 'go test ./...', 'npm test', 'tree -L 1']) {
    assert.equal(sanitizeCommand(c, normal, { cwd: d }).changed, false, c);
  }
});

// ---------------------------------------------------------------- safety
test('destructive and protected commands are never rewritten', () => {
  for (const c of [
    'rm -rf build', 'mv a b', 'git push origin main', 'git reset --hard', 'git checkout main', 'git clean -fdx',
    'git commit -m "git log"', 'npm run deploy', 'npx prisma migrate deploy', 'terraform apply', 'kubectl logs pod',
    'sudo git status', 'cd /tmp && rm -rf x',
  ]) {
    const r = S(c);
    assert.equal(r.changed, false, c);
  }
});

test('protected paths block rewriting', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'node_modules'));
  for (const c of ['cat .env', 'cat config/.env.local', 'grep -r KEY secrets', 'cat server.pem', 'cat id.key', 'find credentials']) {
    const r = sanitizeCommand(c, strict, { cwd: d });
    assert.equal(r.changed, false, c);
    assert.match(r.skipped || '', /protected/, c);
  }
});

test('user denylist extends built-ins', () => {
  const d = tmpDir();
  const cfg = cfgFor(d, { protectedCommands: ['git log'] });
  assert.equal(sanitizeCommand('git log', cfg, { cwd: repo }).changed, false);
  assert.ok(cfg.protectedCommands.includes('git push'), 'built-ins cannot be removed');
});

test('isProtected matches whole words only', () => {
  assert.equal(isProtected('grep -r perm .', normal), null);
  assert.match(isProtected('git rm x', normal), /rm/);
});

test('TP_RAW=1 escape hatch disables rewriting', () => {
  assert.equal(S('TP_RAW=1 git log').changed, false);
});

test('pipes, subshells, multiline and quoting edge cases are untouched', () => {
  for (const c of ['git log | head -5', 'git log > log.txt', '$(git log)', 'git log\ngit status', 'git log "$(whoami)"', 'echo hi; git log', 'git log &&']) {
    assert.equal(S(c).changed, false, c);
  }
});

test('off mode and disabled rewriting do nothing', () => {
  assert.equal(S('git log', off).changed, false);
  const d = tmpDir();
  assert.equal(sanitizeCommand('git log', cfgFor(d, { enableCommandRewriting: false }), { cwd: repo }).changed, false);
});

test('rewritten commands are idempotent', () => {
  const once = S('git log').command;
  assert.equal(S(once).changed, false);
  const f = S('find . -type f').command;
  assert.equal(S(f).changed, false);
});
