'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PLUGIN, tmpDir, cfgFor, fixture } = require('./helpers');
const C = require(path.join(PLUGIN, 'lib', 'compressor.js'));

const normal = cfgFor(tmpDir());
const strict = cfgFor(tmpDir(), {}, 'strict');
const off = cfgFor(tmpDir(), {}, 'off');
const lines = (n, f = (i) => `line ${i} of generic output with some padding text`) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

test('empty output passes through', () => {
  const r = C.compress('', normal);
  assert.equal(r.changed, false);
  assert.equal(r.text, '');
});

test('null/undefined output passes through as empty', () => {
  assert.equal(C.compress(undefined, normal).changed, false);
});

test('tiny output passes through untouched even if many short lines', () => {
  const t = lines(300, (i) => `${i}`); // ~1.1k chars < minCompressChars
  const r = C.compress(t, normal);
  assert.equal(r.changed, false);
  assert.equal(r.text, t);
});

test('output under both thresholds passes through', () => {
  const t = lines(100);
  assert.equal(C.compress(t, normal).changed, false);
});

test('generic large output keeps head and tail with explicit marker and footer', () => {
  const t = lines(2000);
  const r = C.compress(t, normal, { command: 'cat big.txt', rawPath: '.claude/token-plus/raw/x.log' });
  assert.equal(r.changed, true);
  const out = r.text.split('\n');
  assert.equal(out[0], 'line 0 of generic output with some padding text');
  assert.ok(out.includes('line 49 of generic output with some padding text'));
  assert.ok(!out.includes('line 50 of generic output with some padding text'));
  assert.ok(out.includes('line 1999 of generic output with some padding text'));
  assert.match(r.text, /\[token-plus: elided 1,875 lines\]/);
  assert.match(r.text, /original 2,000 lines\/[\d,]+ chars → kept \d+ lines \| ~[\d,]+ tokens saved \(est\.\) \| mode=generic \| full output: \.claude\/token-plus\/raw\/x\.log\]$/);
  assert.ok(r.stats.tokensSaved > 10000);
  assert.ok(r.text.length < t.length / 5);
});

test('errors in the elided middle are rescued', () => {
  const t = lines(1000, (i) => (i === 500 ? 'Error: database connection refused at db.js:42' : `ok step ${i} done fine with padding padding`));
  const r = C.compress(t, normal);
  assert.match(r.text, /Error: database connection refused/);
  assert.match(r.text, /ok step 499/); // context line
});

test('off mode and disabled compression pass through', () => {
  const t = lines(2000);
  assert.equal(C.compress(t, off).changed, false);
  assert.equal(C.compress(t, Object.assign({}, normal, { enableOutputCompression: false })).changed, false);
});

test('strict mode keeps fewer lines than normal', () => {
  const t = lines(2000);
  const n = C.compress(t, normal);
  const s = C.compress(t, strict);
  assert.ok(s.text.length < n.text.length);
  assert.ok(s.stats.keptLines < n.stats.keptLines);
});

test('binary output is replaced with a notice', () => {
  const bin = Buffer.from(Array.from({ length: 10000 }, (_, i) => i % 256)).toString('latin1');
  const r = C.compress(bin, normal, { rawPath: 'raw.log' });
  assert.equal(r.changed, true);
  assert.match(r.text, /^\[token-plus: binary output \([\d,]+ bytes\) not shown; saved to raw\.log\]$/);
});

test('unicode output is preserved intact in kept regions', () => {
  const t = lines(1000, (i) => `行 ${i}: héllo wörld 🚀 — ✓ données`);
  const r = C.compress(t, normal);
  assert.equal(r.changed, true);
  assert.ok(r.text.startsWith('行 0: héllo wörld 🚀 — ✓ données'));
  assert.doesNotMatch(r.text, /�/);
});

test('extremely long single line is middle-truncated without splitting surrogate pairs', () => {
  const t = '🚀'.repeat(50000);
  const r = C.compress(t, normal);
  assert.equal(r.changed, true);
  assert.match(r.text, /…\[token-plus: [\d,]+ chars elided\]…/);
  assert.doesNotMatch(r.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
  assert.ok(r.text.length < 10000);
});

test('ANSI escapes and carriage-return progress are normalised', () => {
  const t = lines(400, (i) => `\u001b[32m✓\u001b[0m downloading ${i}%\r\u001b[1mstep ${i} complete with some more text\u001b[0m`);
  const r = C.compress(t, normal);
  assert.doesNotMatch(r.text, /\u001b\[/);
  assert.match(r.text, /^step 0 complete/);
});

test('identical repeated lines are collapsed with a count', () => {
  const t = ['start', ...Array(3000).fill('retrying connection to upstream service...'), 'Error: gave up after 3000 attempts', 'end'].join('\n');
  const r = C.compress(t, normal);
  assert.match(r.text, /retrying connection to upstream service\.\.\. {2}\[token-plus: ×3000 identical lines\]/);
  assert.match(r.text, /Error: gave up/);
  assert.ok(r.text.length < 1000);
});

test('gain under 10% passes through untouched', () => {
  // 160 unique lines just over the line threshold: head 50 + tail 75 keeps most of it
  const t = lines(160);
  const big = Object.assign({}, normal, { headLines: 80, tailLines: 75 });
  const r = C.compress(t, big);
  assert.equal(r.changed, false);
});

// ---------------------------------------------------------------- fixtures
test('pytest: failures, failing test names and summary survive', () => {
  const r = C.compress(fixture('pytest_fail.txt'), normal, { command: 'pytest' });
  assert.equal(r.changed, true);
  assert.equal(r.stats.kind, 'test');
  for (const s of ['test_case_137', 'test_case_241', 'assert 9 == 10', 'JSONDecodeError', '2 failed, 298 passed', 'tests/test_mod4.py:88']) {
    assert.ok(r.text.includes(s), s);
  }
  assert.ok(r.stats.keptChars < r.stats.origChars / 3);
});

test('jest: failing suite and totals survive, PASS spam removed', () => {
  const r = C.compress(fixture('jest_fail.txt'), normal, { command: 'npx jest' });
  for (const s of ['FAIL src/api/client.test.ts', 'retries on 503', 'Expected: 3', 'Received: 1', 'Tests:       1 failed, 912 passed']) assert.ok(r.text.includes(s), s);
  assert.ok((r.text.match(/^PASS /gm) || []).length < 5);
});

test('go test -v: FAIL lines survive, RUN/PASS spam removed', () => {
  const r = C.compress(fixture('go_test.txt'), normal, { command: 'go test -v ./...' });
  for (const s of ['--- FAIL: TestBroken', 'expected 4, got 5', 'FAIL\texample.com/pkg']) assert.ok(r.text.includes(s), s);
  assert.ok(!r.text.includes('=== RUN   TestThing100'));
});

test('npm install: deprecations deduped, vulnerabilities and result kept', () => {
  const r = C.compress(fixture('npm_install.txt'), normal, { command: 'npm install' });
  assert.equal(r.stats.kind, 'install');
  for (const s of ['added 812 packages', '3 high severity vulnerabilities', 'npm audit fix', 'deprecated glob@7.2.3']) assert.ok(r.text.includes(s), s);
  assert.ok((r.text.match(/deprecated inflight/g) || []).length <= 2);
  assert.ok(!/npm http fetch/.test(r.text));
});

test('python traceback: exception and user frames kept, framework frames folded', () => {
  const r = C.compress(fixture('python_traceback.txt'), normal, { command: 'python worker.py' });
  for (const s of ['Traceback (most recent call last):', "KeyError: 'user_id'", 'handler59.py']) assert.ok(r.text.includes(s), s);
  assert.match(r.text, /stack frame lines elided/);
});

test('java stack: exception, cause and first frames kept', () => {
  const r = C.compress(fixture('java_stack.txt'), normal, { command: 'java -jar app.jar' });
  for (const s of ['IllegalStateException: Failed to load ApplicationContext', 'Caused by: java.sql.SQLException: Connection refused', 'Abstract0.refresh', '... 42 more']) {
    assert.ok(r.text.includes(s), s);
  }
  assert.ok(r.text.length < fixture('java_stack.txt').length / 2);
});

test('webpack build: progress removed, error and final status kept, warnings deduped', () => {
  const r = C.compress(fixture('webpack_build.txt'), normal, { command: 'npm run build' });
  assert.equal(r.stats.kind, 'build');
  for (const s of ['ERROR in ./src/app.tsx 44:10', 'TS2322', 'compiled with 1 error and 15 warnings']) assert.ok(r.text.includes(s), s);
  assert.ok(!/building modules 200\/400/.test(r.text));
  assert.ok((r.text.match(/WARNING in \.\/src\/legacy\.js/g) || []).length <= 2);
});

test('cargo build: Compiling spam removed, diagnostics kept', () => {
  const r = C.compress(fixture('cargo_build.txt'), normal, { command: 'cargo build' });
  for (const s of ['error[E0308]: mismatched types', '--> src/lib.rs:42:5', 'could not compile', 'unused variable']) assert.ok(r.text.includes(s), s);
  assert.ok(!r.text.includes('Compiling crate100'));
});

test('detectKind classifies by command and content', () => {
  assert.equal(C.detectKind('pytest -q', ''), 'test');
  assert.equal(C.detectKind('pnpm install', ''), 'install');
  assert.equal(C.detectKind('tsc --noEmit', ''), 'build');
  assert.equal(C.detectKind('git diff', ''), 'git');
  assert.equal(C.detectKind('python x.py', 'Traceback (most recent call last):\n'), 'stacktrace');
  assert.equal(C.detectKind('cat x', 'hello'), 'generic');
});

test('generic file dumps do not lose lines that merely look like build output', () => {
  const t = lines(400, (i) => (i === 10 ? '   Compiling the report v1.0' : `content line ${i} with enough text to be counted`));
  const r = C.compress(t, normal, { command: 'cat notes.md' });
  assert.ok(r.text.includes('Compiling the report v1.0'));
});
