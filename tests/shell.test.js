'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PLUGIN } = require('./helpers');
const { scan, splitEnv, quote, rebuild } = require(path.join(PLUGIN, 'lib', 'shell.js'));

test('simple commands are accepted with raw tokens preserved', () => {
  const r = scan(`git log --format='%h %s' "my file.txt"`);
  assert.equal(r.ok, true);
  const t = r.segments[0];
  assert.deepEqual(t.map((x) => x.value), ['git', 'log', '--format=%h %s', 'my file.txt']);
  assert.equal(t[2].raw, `--format='%h %s'`);
  assert.equal(t[3].raw, `"my file.txt"`);
});

test('unicode arguments survive scanning', () => {
  const r = scan('grep -rn "héllo 世界 🚀" src');
  assert.equal(r.ok, true);
  assert.equal(r.segments[0][2].value, 'héllo 世界 🚀');
});

for (const [cmd, why] of [
  ['git log | head', 'pipe'],
  ['git log; rm -rf /', 'multiple statements'],
  ['git log > out.txt', 'redirection'],
  ['cat < in', 'redirection'],
  ['echo $(git log)', 'parameter or command expansion'],
  ['echo `git log`', 'command substitution'],
  ['(cd x; git log)', 'subshell or grouping'],
  ['git log &', 'background job'],
  ['git log || true', '|| operator'],
  ['git log\ngit status', 'multiline command'],
  ['cat <<EOF\nhi\nEOF', 'redirection'],
  ['git log "$HOME"', 'expansion inside double quotes'],
  ['git log # comment', 'comment'],
  ['git log "unterminated', 'unterminated quote'],
  ['git status && git log', '&& only allowed after a single cd'],
  ['{ git log; }', 'brace group'],
  ['git log \\\n --oneline', 'line continuation'],
]) {
  test(`complex command rejected: ${JSON.stringify(cmd)}`, () => {
    const r = scan(cmd);
    assert.equal(r.ok, false);
    assert.equal(r.reason, why);
  });
}

test('cd prefix with && is the only accepted compound form', () => {
  const r = scan('cd sub && git log');
  assert.equal(r.ok, true);
  assert.equal(r.segments.length, 2);
  assert.equal(rebuild(r, [], ['git', 'log', '-n', '5']), 'cd sub && git log -n 5');
});

test('single quotes protect metacharacters', () => {
  const r = scan(`grep -r 'a|b;$c' .`);
  assert.equal(r.ok, true);
  assert.equal(r.segments[0][2].value, 'a|b;$c');
});

test('env assignments are split off', () => {
  const r = scan('TP_RAW=1 FOO=bar git log');
  const { env, words } = splitEnv(r.segments[0]);
  assert.deepEqual(env.map((t) => t.raw), ['TP_RAW=1', 'FOO=bar']);
  assert.deepEqual(words.map((t) => t.value), ['git', 'log']);
});

test('quote() produces shell-safe strings', () => {
  assert.equal(quote('plain-word'), 'plain-word');
  assert.equal(quote("it's"), `'it'\\''s'`);
  assert.equal(quote('*/node_modules/*'), `'*/node_modules/*'`);
  assert.equal(quote(''), "''");
});

test('empty and non-string input', () => {
  assert.equal(scan('').ok, false);
  assert.equal(scan('   ').ok, false);
  assert.equal(scan(null).ok, false);
});
