'use strict';
// Output compressor: shrinks oversized tool output while keeping the parts that matter.
//
// Pipeline (only runs when output exceeds the configured thresholds):
//   1. normalise: strip ANSI escapes, resolve carriage-return progress redraws
//   2. binary detection: binary blobs are replaced by a one-line notice
//   3. noise removal (mode dependent): progress bars, download spam, success spam
//   4. de-duplication: runs of identical lines -> one line + "[×N]"
//   5. stack-trace folding: long frame runs keep their first/last frames
//   6. long-line truncation
//   7. head + tail + rescued "important" lines (errors, failures, summaries) from the middle
// Every elision is marked inline with "[token-plus: ...]" and a footer reports
// original/kept lines and the estimated tokens saved. The caller saves the full original.

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>]/g;

const IMPORTANT = [
  /\b(error|errors|err!|fatal|panic|panicked|exception|traceback|segmentation fault|core dumped|abort(ed)?)\b/i,
  /\b(fail|failed|failure|failures|failing)\b/i,
  /^\s*(E\s{2,}|>\s{3})/, // pytest error/assert lines
  /\bassert(ion)?(error)?\b/i,
  /[✗✕✖×]\s|\bnot ok\b/,
  /^(FAIL|FAILED|ERROR|ERR|PANIC)\b/,
  /\b(cve-\d{4}-\d+|vulnerabilit(y|ies)|critical|high severity|deprecated)\b/i,
  /\bwarning\b/i,
  /^\s*(caused by|during handling of the above exception)/i,
  /^\s*[^\s:]+:\d+:\d+:?\s/, // file:line:col: compiler diagnostics
  /^\s*-->\s+\S+:\d+/, // rust diagnostics
  /exit (code|status) [1-9]/i,
  /\bTS\d{4}\b/, // typescript errors
  /^\s*thread '.*' panicked/,
];

const SUMMARY = [
  /^=+ .*(passed|failed|error|skipped|warnings?|no tests ran).* =+$/i, // pytest summary
  /^(Tests?|Test Suites|Snapshots|Time):\s+/, // jest
  /^\s*(\d+ (passing|failing|pending))/, // mocha
  /^(ok|FAIL|PASS)\s+\S+\s+[\d.]+s/, // go test package lines
  /^test result: /, // cargo
  /\b(build|compilation) (succeeded|successful|failed|complete)/i,
  /^(BUILD (SUCCESS|FAILURE|SUCCESSFUL|FAILED))/,
  /\b(added|removed|changed|audited) \d+ packages?/i,
  /^Successfully (installed|built)/,
  /\bfound \d+ vulnerabilit/i,
  /^\s*\d+ (problems?|errors?|warnings?)\b/i,
  /^(Ran \d+ tests?|OK|FAILED \()/,
  /^npm (ERR!|error)/,
  /Done in [\d.]+s/,
];

const PROGRESS = [
  /^\s*\[?[#=>.\-\s]{10,}\]?\s*\d{1,3}(\.\d+)?%/,
  /^\s*\d{1,3}(\.\d+)?%\s*(\||\[|$)/,
  /[█▉▊▋▌▍▎▏░▒▓━─]{6,}/,
  /^\s*[⠁-⣿|/\\-]\s+\S/, // spinners
  /^(Downloading|Downloaded|Fetching|Resolving|Receiving objects|Resolving deltas|Counting objects|Compressing objects|Unpacking objects|remote: (Counting|Compressing|Enumerating))\b.*(\d+%|\d+(\.\d+)?\s*[kKmMgG]i?B|\.\.\.)/,
  /^\s*(Compiling|Checking|Fresh|Building|Bundling|Transforming|Linking)\s+\S+( v\d[\w.\-+]*)?( \(.*\))?\s*$/,
  /^Requirement already satisfied: /,
  /^\s*Using cached /,
  /^\s*Collecting /,
  /^(Progress|progress)[:\s]/,
  /^\[INFO\] (Download(ing|ed) from|Progress)/,
  /^npm (http|timing|sill|verb) /,
  /^\s*(\d+\/\d+\s+)?(modules?|chunks?|assets?) (transformed|built)/,
];

const SUCCESS_SPAM = [
  /^\s*(✓|✔|√|PASS(ED)?\b|ok\s+\d+\s)/,
  /^[.sx]+\s*(\[\s*\d+%\])?$/, // pytest progress dots without failures
  /^\s*\S+::\S+ PASSED/,
  /^=== RUN\s/,
  /^--- PASS:/,
  /^\s*test \S+ \.\.\. ok$/,
];

const FRAME = [
  /^\s+at\s+\S/, // JS / Java / C#
  /^\s+File ".*", line \d+/, // Python
  /^\s*#\d+\s+(0x[0-9a-f]+\s+in\s+)?\S/, // C/C++/gdb, PHP
  /^\s+\d+:\s+0x[0-9a-f]+\s+-\s/, // rust backtrace
  /^\s+from \S+:\d+:in /, // ruby
  /^\s+\S+\.go:\d+/, // go
];
const INTERNAL_FRAME = /(node:internal|node_modules|site-packages|dist-packages|<frozen |java\.base\/|jdk\.internal|sun\.reflect|org\.junit\.|\/usr\/lib\/python|runtime\/|\/rustc\/)/;

function stripAnsi(s) {
  return s.replace(ANSI, '');
}

// Resolve terminal redraws: "a\rb" -> "b" for each line.
function resolveCR(line) {
  if (!line.includes('\r')) return line;
  const parts = line.split('\r').filter((p) => p.length);
  return parts.length ? parts[parts.length - 1] : '';
}

function isBinary(s) {
  if (!s) return false;
  const sample = s.slice(0, 8192);
  if (sample.includes('\u0000')) return true;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c < 9 || (c > 13 && c < 32) || c === 0xfffd) && c !== 27) bad++;
  }
  return bad / sample.length > 0.1;
}

function detectKind(command, text) {
  const c = (command || '').toLowerCase();
  if (/\b(pytest|py\.test|jest|vitest|mocha|go test|cargo test|rspec|phpunit|unittest|npm (run )?test|yarn test|pnpm test|bun test|ctest|mvn test|gradlew? test|tox|nox)\b/.test(c)) return 'test';
  if (/\b(npm (install|i|ci|add)|yarn (install|add)|pnpm (install|add|i)|pip3? install|poetry (install|add)|uv (pip|sync|add)|bundle install|composer (install|require)|apt(-get)? install|brew install|go (get|mod download))\b/.test(c)) return 'install';
  if (/\b(build|compile|make|cmake|tsc|webpack|vite|rollup|esbuild|cargo (build|check|clippy)|gradlew?|mvn|docker build|next build|lint|eslint)\b/.test(c)) return 'build';
  if (/^\s*(git|cd \S+ && git)\b/.test(c)) return 'git';
  const t = text.slice(0, 20000);
  if (/^Traceback \(most recent call last\)|^\s+at .+\(.+:\d+:\d+\)|^Exception in thread|panicked at/m.test(t)) return 'stacktrace';
  if (/(\d+ (passed|failed)|Tests?:\s+\d+|^(FAIL|PASS) |^--- FAIL:|^test result:)/m.test(t)) return 'test';
  return 'generic';
}

function truncateLine(line, max) {
  if (line.length <= max) return { line, cut: 0 };
  const chars = Array.from(line); // avoid splitting surrogate pairs
  if (chars.length <= max) return { line, cut: 0 };
  const keepHead = Math.floor(max * 0.6);
  const keepTail = Math.floor(max * 0.25);
  const cut = chars.length - keepHead - keepTail;
  return {
    line: chars.slice(0, keepHead).join('') + ` …[token-plus: ${cut.toLocaleString('en-US')} chars elided]… ` + chars.slice(chars.length - keepTail).join(''),
    cut,
  };
}

// Collapse runs of identical lines.
function dedupe(lines) {
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const n = j - i;
    if (n >= 3 && lines[i].trim()) {
      out.push(`${lines[i]}  [token-plus: ×${n} identical lines]`);
      removed += n - 1;
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return { lines: out, removed };
}

// Collapse warnings that differ only by numbers/paths (only lines containing "warn"/"deprecat").
// In build/install logs (allLines=true) any exact non-blank line repeated more than twice is
// also dropped, which catches multi-line warning blocks that alternate with other lines.
function dedupeWarnings(lines, allLines = false) {
  const seen = new Map();
  const out = [];
  let removed = 0;
  for (const l of lines) {
    const isWarn = /warn|deprecat/i.test(l) && !/error|fail/i.test(l);
    if (isWarn || (allLines && l.trim().length > 3 && !l.startsWith('[token-plus:'))) {
      const key = isWarn ? 'w:' + l.replace(/\d+/g, '#').replace(/(\/|\\)[^\s:'"]+/g, '/…').trim() : 'x:' + l;
      const c = seen.get(key) || 0;
      seen.set(key, c + 1);
      if (c >= 2) {
        removed++;
        continue;
      }
    }
    out.push(l);
  }
  if (removed) {
    const dup = [...seen.entries()].filter(([, c]) => c > 2).length;
    out.push(`[token-plus: ${removed} repeated warning/duplicate lines removed (${dup} distinct patterns, first 2 of each kept)]`);
  }
  return { lines: out, removed };
}

function foldFrames(lines, keepFirst = 3, keepLast = 3) {
  const out = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    if (!FRAME.some((re) => re.test(lines[i]))) {
      out.push(lines[i++]);
      continue;
    }
    let j = i;
    // python frames are two lines (File ..., code line); treat indented follow-ups as part of the run
    while (j < lines.length && (FRAME.some((re) => re.test(lines[j])) || (/^\s{4,}\S/.test(lines[j]) && j > i))) j++;
    const run = lines.slice(i, j);
    if (run.length <= keepFirst + keepLast + 2) {
      out.push(...run);
    } else {
      const head = run.slice(0, keepFirst);
      const tail = run.slice(run.length - keepLast);
      const middle = run.slice(keepFirst, run.length - keepLast);
      // keep the first non-internal frames from the middle: they are usually the user's code
      const userFrames = middle.filter((l) => FRAME.some((re) => re.test(l)) && !INTERNAL_FRAME.test(l)).slice(0, 3);
      out.push(...head);
      const dropped = middle.length - userFrames.length;
      if (userFrames.length) out.push(...userFrames);
      out.push(`    [token-plus: ${dropped} stack frame lines elided]`);
      out.push(...tail);
      removed += dropped;
    }
    i = j;
  }
  return { lines: out, removed };
}

function removeNoise(lines, kind) {
  let removed = 0;
  const out = [];
  const spam = kind === 'test' ? SUCCESS_SPAM : [];
  for (const l of lines) {
    const t = l.trim();
    if (IMPORTANT.some((re) => re.test(l)) && !PROGRESS.slice(0, 4).some((re) => re.test(l))) {
      out.push(l);
      continue;
    }
    const progressRules = kind === 'build' || kind === 'install' || kind === 'test' ? PROGRESS : kind === 'git' ? [] : PROGRESS.slice(0, 3);
    if (progressRules.some((re) => re.test(t))) {
      removed++;
      continue;
    }
    if (spam.some((re) => re.test(l))) {
      removed++;
      continue;
    }
    out.push(l);
  }
  // collapse blank-line runs
  const res = [];
  for (const l of out) {
    if (!l.trim() && res.length && !res[res.length - 1].trim()) {
      removed++;
      continue;
    }
    res.push(l);
  }
  return { lines: res, removed };
}

function estimateTokens(chars, cfg) {
  return Math.round(chars * (cfg.tokensPerChar || 0.25));
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * Compress output text.
 * @returns {{changed:boolean, text:string, stats:object}}
 */
function compress(text, cfg, opts = {}) {
  const original = typeof text === 'string' ? text : text == null ? '' : String(text);
  const origChars = original.length;
  const origLines = original ? original.split('\n').length : 0;
  const base = { origChars, origLines, keptChars: origChars, keptLines: origLines, kind: 'none', tokensSaved: 0 };
  const pass = (reason) => ({ changed: false, text: original, stats: Object.assign(base, { reason }) });

  if (cfg.mode === 'off' || cfg.enableOutputCompression === false) return pass('disabled');
  if (!original) return pass('empty');
  if (origChars < (cfg.minCompressChars || 0)) return pass('below minimum');
  if (origLines <= cfg.maxToolOutputLines && origChars <= cfg.maxToolOutputChars) return pass('below threshold');

  if (isBinary(original)) {
    const msg = `[token-plus: binary output (${fmt(Buffer.byteLength(original))} bytes) not shown${opts.rawPath ? `; saved to ${opts.rawPath}` : ''}]`;
    return {
      changed: true,
      text: msg,
      stats: Object.assign(base, { kind: 'binary', keptChars: msg.length, keptLines: 1, tokensSaved: estimateTokens(origChars - msg.length, cfg) }),
    };
  }

  const kind = opts.kind || detectKind(opts.command, original);
  let lines = stripAnsi(original).split('\n').map(resolveCR);
  const notes = [];

  let r = removeNoise(lines, kind);
  lines = r.lines;
  if (r.removed) notes.push(`${r.removed} progress/noise`);
  r = dedupe(lines);
  lines = r.lines;
  if (r.removed) notes.push(`${r.removed} duplicate`);
  if (kind === 'build' || kind === 'install' || kind === 'test') {
    r = dedupeWarnings(lines, kind !== 'test');
    lines = r.lines;
    if (r.removed) notes.push(`${r.removed} repeated-warning`);
  }
  r = foldFrames(lines);
  lines = r.lines;
  if (r.removed) notes.push(`${r.removed} stack-frame`);

  let cutChars = 0;
  lines = lines.map((l) => {
    const t = truncateLine(l, cfg.maxLineChars || 2000);
    cutChars += t.cut;
    return t.line;
  });

  // Head/tail window with important lines rescued from the middle.
  const H = cfg.headLines;
  const T = cfg.tailLines;
  let elidedMiddle = 0;
  const totalAfterClean = lines.join('\n').length;
  if (lines.length > H + T + 1 && (lines.length > cfg.maxToolOutputLines || totalAfterClean > cfg.maxToolOutputChars)) {
    const head = lines.slice(0, H);
    const tail = lines.slice(lines.length - T);
    const middle = lines.slice(H, lines.length - T);
    const keep = new Set();
    const isImp = (l) => IMPORTANT.some((re) => re.test(l)) || SUMMARY.some((re) => re.test(l.trim()));
    let budget = cfg.maxImportantLines;
    for (let i = 0; i < middle.length && budget > 0; i++) {
      if (isImp(middle[i])) {
        // include one line of context on each side for readability
        for (const k of [i - 1, i, i + 1]) {
          if (k >= 0 && k < middle.length && !keep.has(k) && budget > 0) {
            keep.add(k);
            budget--;
          }
        }
      }
    }
    const kept = [...head];
    let gap = 0;
    for (let i = 0; i < middle.length; i++) {
      if (keep.has(i)) {
        if (gap) kept.push(`[token-plus: elided ${fmt(gap)} lines]`);
        gap = 0;
        kept.push(middle[i]);
      } else gap++;
    }
    if (gap) kept.push(`[token-plus: elided ${fmt(gap)} lines]`);
    kept.push(...tail);
    elidedMiddle = middle.length - keep.size;
    lines = kept;
  }

  // Character budget backstop: if still far above the char limit, shrink head/tail proportionally.
  let out = lines.join('\n');
  const hardCap = Math.max(cfg.maxToolOutputChars * 2, 2000);
  if (out.length > hardCap) {
    const headPart = out.slice(0, Math.floor(hardCap * 0.4));
    const tailPart = out.slice(out.length - Math.floor(hardCap * 0.55));
    const dropped = out.length - headPart.length - tailPart.length;
    out = `${headPart}\n[token-plus: elided ${fmt(dropped)} more chars to fit budget]\n${tailPart}`;
  }

  if (out.length >= origChars * 0.9) return pass('compression gain under 10%');

  const keptLines = out.split('\n').length;
  const saved = estimateTokens(origChars - out.length, cfg);
  const parts = [];
  if (elidedMiddle) parts.push(`${fmt(elidedMiddle)} middle lines`);
  if (notes.length) parts.push(notes.join(', ') + ' lines');
  if (cutChars) parts.push(`${fmt(cutChars)} chars from long lines`);
  const footer =
    `[token-plus: elided ${parts.join('; ') || 'content'} | original ${fmt(origLines)} lines/${fmt(origChars)} chars → kept ${fmt(keptLines)} lines | ~${fmt(saved)} tokens saved (est.) | mode=${kind}` +
    (opts.rawPath ? ` | full output: ${opts.rawPath}` : '') +
    ']';
  const finalText = `${out}\n${footer}`;
  return {
    changed: true,
    text: finalText,
    stats: Object.assign(base, {
      kind,
      keptChars: finalText.length,
      keptLines: keptLines + 1,
      tokensSaved: estimateTokens(origChars - finalText.length, cfg),
    }),
  };
}

module.exports = { compress, detectKind, stripAnsi, isBinary, truncateLine, dedupe, foldFrames, removeNoise, estimateTokens };
