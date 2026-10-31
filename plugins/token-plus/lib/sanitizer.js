'use strict';
// Command sanitizer: rewrites only clearly wasteful, *read-only* Bash invocations.
//
// Safety model (in order):
//   1. Escape hatch: a leading `TP_RAW=1` env assignment disables all rewriting for that command.
//   2. Commands touching protected commands/paths are never rewritten.
//   3. Commands must pass lib/shell.scan(): no pipes, redirects, expansions, subshells,
//      heredocs, comments or multiple statements (only `cd dir && cmd` is accepted).
//   4. Each rule only fires on an allowlisted command shape and bails on any flag it does
//      not understand. When a rule cannot decide, it does nothing.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { scan, splitEnv, quote, rebuild } = require('./shell');

const NOOP = (reason) => ({ changed: false, skipped: reason });

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRe(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += escapeRe(ch);
  }
  return new RegExp('^' + re + '$', 'i');
}

function matchProtectedCommand(command, list) {
  const norm = command.replace(/\s+/g, ' ');
  for (const p of list) {
    const pat = p.trim();
    if (!pat) continue;
    const re = new RegExp('(^|[^A-Za-z0-9_-])' + escapeRe(pat).replace(/ /g, '\\s+') + '($|[^A-Za-z0-9_-])');
    if (re.test(norm)) return pat;
  }
  return null;
}

// Does any word in the command look like it references a protected path?
function matchProtectedPath(command, list) {
  const words = command.split(/[\s'"=:;|&<>()]+/).filter(Boolean);
  const res = list.map((g) => ({ g, re: globToRe(g) }));
  for (const w of words) {
    const segs = w.split('/').filter(Boolean);
    for (const seg of segs) {
      for (const { g, re } of res) if (re.test(seg)) return g;
    }
  }
  return null;
}

function isProtected(command, cfg) {
  const c = matchProtectedCommand(command, cfg.protectedCommands || []);
  if (c) return `protected command "${c}"`;
  const p = matchProtectedPath(command, cfg.protectedPaths || []);
  if (p) return `protected path "${p}"`;
  return null;
}

function run(cmd, args, cwd, timeout = 1500) {
  try {
    return childProcess.execFileSync(cmd, args, {
      cwd,
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
      env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat' }),
    });
  } catch (_) {
    return null;
  }
}

function findGitDir(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    const g = path.join(dir, '.git');
    try {
      const st = fs.statSync(g);
      if (st.isDirectory()) return g;
      if (st.isFile()) {
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
        if (m) return path.resolve(dir, m[1].trim());
      }
    } catch (_) {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Repository operations in progress make the long `git status` output important.
function gitOperationInProgress(gitDir) {
  if (!gitDir) return true; // unknown -> be conservative
  const markers = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
  return markers.some((m) => fs.existsSync(path.join(gitDir, m)));
}

const isFlag = (w) => w.startsWith('-') && w !== '-';

// Locate git subcommand, accepting only harmless global options.
function gitSub(words) {
  let k = 1;
  let cwdOverride = null;
  while (k < words.length) {
    const w = words[k];
    if (w === '--no-pager' || w === '-P') k += 1;
    else if (w === '-C' && k + 1 < words.length) {
      cwdOverride = words[k + 1];
      k += 2;
    } else if (w.startsWith('-')) return null;
    else break;
  }
  if (k >= words.length) return null;
  return { index: k, sub: words[k], cwdOverride };
}

// ---------------------------------------------------------------- git rules

function ruleGitStatus(ctx) {
  const { words, cfg } = ctx;
  if (words[0] !== 'git') return null;
  const g = gitSub(words);
  if (!g || g.sub !== 'status') return null;
  const args = words.slice(g.index + 1);
  if (args.some(isFlag)) return NOOP('git status already has explicit flags');
  const dir = g.cwdOverride ? path.resolve(ctx.cwd, g.cwdOverride) : ctx.cwd;
  if (gitOperationInProgress(findGitDir(dir))) return NOOP('merge/rebase/cherry-pick/bisect in progress or no repo');
  const raw = ctx.raws.slice();
  raw.splice(g.index + 1, 0, '--short', '--branch');
  return {
    words: raw,
    rule: 'git-status-short',
    reason: 'git status → --short --branch (no merge/rebase in progress)',
    note: null,
    estimate: { lines: 8, basis: 'heuristic: typical hint/header lines removed' },
  };
}

const LOG_COUNT = /^(-n\d*|-\d+|--max-count(=.*)?)$/;
const LOG_SEARCH = /^(--grep(=.*)?|-S.*|-G.*|--author(=.*)?|--committer(=.*)?|--since(=.*)?|--until(=.*)?|--after(=.*)?|--before(=.*)?|-L.*|--reverse|--all|--follow)$/;
const LOG_FORMAT = /^(--oneline|--format(=.*)?|--pretty(=.*)?|-p|-u|--patch|--stat.*|--name-only|--name-status|--shortstat|--numstat|-s|--no-patch|--graph|--raw)$/;

function ruleGitLog(ctx) {
  const { words, cfg } = ctx;
  if (words[0] !== 'git') return null;
  const g = gitSub(words);
  if (!g || g.sub !== 'log') return null;
  const args = words.slice(g.index + 1);
  if (args.some((a) => LOG_COUNT.test(a))) return NOOP('git log already limited');
  if (args.some((a) => LOG_SEARCH.test(a))) return NOOP('git log search/range/ordering flags: limiting could hide results');
  if (args.some((a) => a.includes('..'))) return NOOP('explicit revision range');
  if (args.includes('--')) return NOOP('explicit pathspec separator');
  if (args.some((a) => isFlag(a) && !LOG_FORMAT.test(a) && !/^--(no-)?(color|decorate|abbrev-commit|merges|no-merges|first-parent)(=.*)?$/.test(a))) {
    return NOOP('unrecognised git log flag');
  }
  const limit = Math.max(1, Math.floor(cfg.gitLogLimit));
  const dir = g.cwdOverride ? path.resolve(ctx.cwd, g.cwdOverride) : ctx.cwd;
  const countOut = run('git', ['rev-list', '--count', 'HEAD'], dir);
  const total = countOut ? parseInt(countOut.trim(), 10) : NaN;
  if (Number.isFinite(total) && total <= limit) return NOOP(`history has only ${total} commits`);
  const addOneline = !args.some((a) => LOG_FORMAT.test(a));
  const insert = ['-n', String(limit)];
  if (addOneline) insert.unshift('--oneline');
  const raw = ctx.raws.slice();
  raw.splice(g.index + 1, 0, ...insert);
  let estimate = null;
  if (Number.isFinite(total) && addOneline) {
    estimate = { lines: Math.max(0, total * 6 - limit), basis: `heuristic: ${total} commits × ~6 lines vs ${limit} one-line entries` };
  } else if (Number.isFinite(total)) {
    estimate = { lines: null, commits: total - limit, basis: `${total - limit} older commits omitted` };
  }
  return {
    words: raw,
    rule: 'git-log-limit',
    reason: `unbounded git log → ${insert.join(' ')}`,
    note: `token-plus limited git log to ${limit} commits${addOneline ? ' (--oneline)' : ''}. Use explicit -n/--format, or prefix TP_RAW=1, for more.`,
    estimate,
  };
}

const DIFF_SKIP = /^(--stat.*|--name-only|--name-status|--shortstat|--numstat|--summary|--raw|--no-index|--exit-code|--quiet|--output(=.*)?|--check|--dirstat.*|--patch-with-stat|-z|--binary|--full-index)$/;
const DIFF_REV = /^([\w./~^@{}-]*\.\.\.?[\w./~^@{}-]*|(HEAD|@|FETCH_HEAD|ORIG_HEAD)([~^]\d*)*|[0-9a-f]{7,40})$/;
const GENERATED_DIFF = [
  /(^|\/)package-lock\.json$/, /(^|\/)npm-shrinkwrap\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb?$/, /(^|\/)Cargo\.lock$/, /(^|\/)poetry\.lock$/, /(^|\/)Pipfile\.lock$/, /(^|\/)uv\.lock$/,
  /(^|\/)composer\.lock$/, /(^|\/)Gemfile\.lock$/, /(^|\/)go\.sum$/, /(^|\/)flake\.lock$/,
  /\.min\.(js|css)$/, /\.(js|css)\.map$/, /(^|\/)__snapshots__\//, /\.snap$/,
];

function ruleGitDiff(ctx) {
  const { words, cfg } = ctx;
  if (words[0] !== 'git') return null;
  const g = gitSub(words);
  if (!g || g.sub !== 'diff') return null;
  const args = words.slice(g.index + 1);
  if (args.includes('--')) return NOOP('explicit pathspec');
  if (args.some((a) => DIFF_SKIP.test(a))) return NOOP('diff already summarised or used as data');
  const dir = g.cwdOverride ? path.resolve(ctx.cwd, g.cwdOverride) : ctx.cwd;
  for (const a of args) {
    if (isFlag(a)) continue;
    if (!DIFF_REV.test(a)) return NOOP(`ambiguous argument "${a}"`);
    if (fs.existsSync(path.resolve(dir, a))) return NOOP(`argument "${a}" is also a path`);
  }
  const names = run('git', ['diff', '--name-only', ...args], dir, 2500);
  if (names === null) return NOOP('could not inspect diff');
  const generated = names.split('\n').filter((n) => n && GENERATED_DIFF.some((re) => re.test(n)));
  const strictU = cfg.mode === 'strict' && !args.some((a) => /^(-U\d*|--unified(=.*)?|-W|--function-context)$/.test(a));
  if (!generated.length && !strictU) return NOOP('no lockfile/generated changes');

  const raw = ctx.raws.slice();
  if (strictU) raw.splice(g.index + 1, 0, '--unified=1');
  let estimate = null;
  let note = '';
  if (generated.length) {
    // repo-root relative pathspecs so behaviour does not depend on the cwd
    raw.push('--', quote(':/'), ...generated.map((f) => quote(`:(top,exclude)${f}`)));
    const num = run('git', ['diff', '--numstat', ...args, '--', ...generated.map((f) => `:(top)${f}`)], dir, 2500);
    let lines = 0;
    if (num) for (const l of num.split('\n')) {
      const m = /^(\d+)\s+(\d+)/.exec(l);
      if (m) lines += parseInt(m[1], 10) + parseInt(m[2], 10);
    }
    estimate = { lines, basis: 'measured: numstat of excluded files' };
    const shown = generated.slice(0, 5).join(', ') + (generated.length > 5 ? `, +${generated.length - 5} more` : '');
    note = `token-plus excluded lockfile/generated diffs (${shown}; ~${lines} lines). View with: TP_RAW=1 git diff -- <file>.`;
  }
  if (strictU) note = (note ? note + ' ' : '') + 'Strict mode: diff context reduced to 1 line (--unified=1).';
  return {
    words: raw,
    rule: generated.length ? 'git-diff-exclude-generated' : 'git-diff-context',
    reason: generated.length ? `git diff excluding ${generated.length} lockfile/generated file(s)` : 'strict: git diff --unified=1',
    note,
    estimate,
  };
}

// ---------------------------------------------------------------- find

const FIND_DANGEROUS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|prune|quit|maxdepth|mindepth|depth|o|or|not|a|and|newer.*|samefile|regex|iregex)$/;

function ruleFind(ctx) {
  const { words, cfg } = ctx;
  if (words[0] !== 'find') return null;
  let k = 1;
  while (k < words.length && ['-H', '-L', '-P'].includes(words[k])) k++;
  const startIdx = k;
  while (k < words.length && !words[k].startsWith('-') && words[k] !== '!' && words[k] !== '(') k++;
  const starts = words.slice(startIdx, k);
  const expr = words.slice(k);
  if (expr.some((w) => FIND_DANGEROUS.test(w) || w === '!' || w === '(' || w === ')')) {
    return NOOP('find expression has actions/limits/operators');
  }
  // Only pure listings are depth-limited. Name/content searches are left alone because
  // a depth cap could make Claude conclude a file does not exist.
  let j = 0;
  while (j < expr.length) {
    if (expr[j] === '-type' && /^[fdl]$/.test(expr[j + 1] || '')) j += 2;
    else if (expr[j] === '-print') j += 1;
    else return NOOP('find is a search (has predicates), not a listing');
  }
  const depth = Math.max(1, Math.floor(cfg.findMaxDepth));
  const raw = ctx.raws.slice();
  const insertAt = startIdx + starts.length;
  raw.splice(insertAt, 0, '-maxdepth', String(depth));
  const touchesIgnored = starts.some((s) => /(^|\/)(node_modules|\.git)(\/|$)/.test(s));
  if (!touchesIgnored) raw.push('-not', '-path', quote('*/node_modules/*'), '-not', '-path', quote('*/.git/*'));
  return {
    words: raw,
    rule: 'find-listing-depth',
    reason: `unbounded find listing → -maxdepth ${depth}${touchesIgnored ? '' : ', skip node_modules/.git'}`,
    note: `token-plus capped this find listing at depth ${depth}${touchesIgnored ? '' : ' and skipped node_modules/.git'}. Prefer Glob with a pattern; prefix TP_RAW=1 for the full listing.`,
    estimate: null,
  };
}

// ---------------------------------------------------------------- grep

const GREP_EXCLUDES = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', 'coverage', '.tox', '.mypy_cache'];

function ruleGrep(ctx) {
  const { words } = ctx;
  if (!['grep', 'egrep', 'fgrep'].includes(words[0])) return null;
  const flags = words.slice(1).filter(isFlag);
  const recursive = flags.some((f) => f === '--recursive' || f === '--dereference-recursive' || (/^-[A-Za-z]+$/.test(f) && /[rR]/.test(f)));
  if (!recursive) return null;
  if (flags.some((f) => /^--(exclude-dir|include|exclude)(=|$)/.test(f))) return NOOP('grep already has include/exclude filters');
  if (flags.some((f) => !/^-[A-Za-z]+$/.test(f) && !/^--(recursive|dereference-recursive|line-number|ignore-case|word-regexp|files-with-matches|count|fixed-strings|extended-regexp|perl-regexp|color(=.*)?|no-messages|with-filename|no-filename|max-count=\d+|context=\d+|after-context=\d+|before-context=\d+)$/.test(f))) {
    return NOOP('unrecognised grep long option');
  }
  const nonFlags = words.slice(1).filter((w) => !isFlag(w));
  const roots = nonFlags.slice(1);
  const searchRoots = roots.length ? roots : ['.'];
  if (searchRoots.some((r) => !fs.existsSync(path.resolve(ctx.cwd, r)))) return NOOP('search path does not exist (let grep report it)');
  const present = GREP_EXCLUDES.filter((d) => {
    if (searchRoots.some((r) => r.split('/').includes(d))) return false; // user is searching inside it
    return searchRoots.some((r) => {
      try {
        return fs.statSync(path.resolve(ctx.cwd, r, d)).isDirectory();
      } catch (_) {
        return false;
      }
    });
  });
  if (!present.length) return NOOP('no vendored/build directories to exclude');
  const raw = ctx.raws.slice();
  raw.splice(1, 0, ...present.map((d) => `--exclude-dir=${quote(d)}`));
  return {
    words: raw,
    rule: 'grep-exclude-dirs',
    reason: `recursive grep → exclude ${present.join(', ')}`,
    note: `token-plus excluded ${present.join(', ')} from this recursive grep. The Grep tool (ripgrep) with a glob is usually cheaper; prefix TP_RAW=1 to search everything.`,
    estimate: null,
  };
}

// ---------------------------------------------------------------- cat

function countLines(file, maxBytes = 64 * 1024 * 1024) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > maxBytes) return { lines: null, bytes: st.size };
  const buf = fs.readFileSync(file);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  if (buf.length && buf[buf.length - 1] !== 10) n++;
  return { lines: n, bytes: st.size };
}

function ruleCat(ctx) {
  const { words, cfg } = ctx;
  if (words[0] !== 'cat' || words.length !== 2 || isFlag(words[1])) return null;
  const file = path.resolve(ctx.cwd, words[1]);
  let info;
  try {
    info = countLines(file);
  } catch (_) {
    return NOOP('file not readable');
  }
  if (info.lines === null || info.lines <= cfg.largeFileWarningLines) return NOOP('file is not large');
  if (cfg.mode !== 'strict') {
    return {
      words: null, // advisory only in normal mode; output compression still applies
      rule: 'cat-large-advice',
      reason: `cat of ${info.lines}-line file (advisory only)`,
      note: `token-plus: ${words[1]} has ${info.lines} lines. Prefer Grep for the symbol you need, or Read with offset/limit. Output will be compressed; full text is kept in the raw log.`,
      estimate: null,
    };
  }
  const n = Math.max(20, cfg.maxToolOutputLines);
  const raw = ['head', '-n', String(n), '--', ctx.raws[1], '&&', 'echo',
    quote(`[token-plus: showed lines 1-${n} of ${info.lines}. Use Read with offset/limit, Grep, or TP_RAW=1 cat for more]`)];
  return {
    words: raw,
    rule: 'cat-large-head',
    reason: `strict: cat of ${info.lines}-line file → head -n ${n}`,
    note: null,
    estimate: { lines: info.lines - n, chars: Math.round(info.bytes * (1 - n / info.lines)), basis: 'measured: file size' },
  };
}

// ---------------------------------------------------------------- installers / runners

function addFlagsAfter(ctx, idx, flags, rule, reason) {
  const missing = flags.filter((f) => !ctx.words.includes(f.split('=')[0]) && !ctx.words.includes(f));
  if (!missing.length) return NOOP('flags already present');
  const raw = ctx.raws.slice();
  raw.splice(idx + 1, 0, ...missing);
  return { words: raw, rule, reason: `${reason}: + ${missing.join(' ')}`, note: null, estimate: null };
}

function ruleNpmInstall(ctx) {
  const { words } = ctx;
  if (words[0] !== 'npm' || !['install', 'i', 'ci', 'add'].includes(words[1])) return null;
  if (words.some((w) => /^--(fund|loglevel|silent|verbose|json)/.test(w) || w === '-s' || w === '-d')) return NOOP('npm output flags set');
  return addFlagsAfter(ctx, 1, ['--no-fund'], 'npm-install-quiet', 'npm install');
}

function rulePipInstall(ctx) {
  const { words } = ctx;
  let idx = -1;
  if ((words[0] === 'pip' || words[0] === 'pip3') && words[1] === 'install') idx = 1;
  else if (/^python[0-9.]*$/.test(words[0]) && words[1] === '-m' && words[2] === 'pip' && words[3] === 'install') idx = 3;
  if (idx < 0) return null;
  if (words.some((w) => w === '-v' || w === '--verbose' || w.startsWith('--progress-bar'))) return NOOP('pip verbosity set');
  return addFlagsAfter(ctx, idx, ['--progress-bar=off', '--disable-pip-version-check'], 'pip-install-quiet', 'pip install');
}

function rulePytest(ctx) {
  const { words, cfg } = ctx;
  let idx = -1;
  if (words[0] === 'pytest' || words[0] === 'py.test') idx = 0;
  else if (/^python[0-9.]*$/.test(words[0]) && words[1] === '-m' && words[2] === 'pytest') idx = 2;
  if (idx < 0) return null;
  if (words.some((w) => /^(-v+|-q+|--verbose|--quiet|--collect-only|--co|-h|--help)$/.test(w))) return NOOP('pytest verbosity set');
  const flags = ['-q'];
  if (cfg.mode === 'strict' && !words.some((w) => w.startsWith('--tb'))) flags.push('--tb=short');
  return addFlagsAfter(ctx, idx, flags, 'pytest-quiet', 'pytest');
}

function ruleCargo(ctx) {
  const { words } = ctx;
  if (words[0] !== 'cargo' || !['build', 'test', 'check', 'clippy', 'b', 't', 'c'].includes(words[1])) return null;
  const sep = words.indexOf('--');
  const own = sep >= 0 ? words.slice(0, sep) : words;
  if (own.some((w) => /^(-v+|-q|--verbose|--quiet|--message-format.*)$/.test(w))) return NOOP('cargo verbosity set');
  return addFlagsAfter(ctx, 1, ['-q'], 'cargo-quiet', `cargo ${words[1]}`);
}

function ruleGradle(ctx) {
  const { words } = ctx;
  if (!/^(\.\/)?gradlew?$/.test(words[0])) return null;
  if (words.some((w) => w.startsWith('--console'))) return NOOP('console already set');
  return addFlagsAfter(ctx, 0, ['--console=plain'], 'gradle-plain', 'gradle');
}

function ruleTree(ctx) {
  const { words, cfg } = ctx;
  if (words[0] !== 'tree') return null;
  if (words.some((w) => w === '-L' || w.startsWith('-L') || w === '-I' || w === '--help')) return NOOP('tree already limited');
  const depth = cfg.mode === 'strict' ? 2 : 3;
  const raw = ctx.raws.slice();
  raw.splice(1, 0, '-L', String(depth), '-I', quote('node_modules|.git|__pycache__|.venv|dist|build|target'));
  return {
    words: raw,
    rule: 'tree-depth',
    reason: `tree → -L ${depth}, skip vendored dirs`,
    note: `token-plus limited tree to depth ${depth}. Prefix TP_RAW=1 for the full tree.`,
    estimate: null,
  };
}

function ruleLogs(ctx) {
  const { words } = ctx;
  if (words[0] === 'docker' && words[1] === 'logs') {
    if (words.some((w) => /^(--tail|-n|--since|--until|-f|--follow)(=|$)/.test(w))) return NOOP('docker logs already bounded');
    const raw = ctx.raws.slice();
    raw.splice(2, 0, '--tail', '200');
    return { words: raw, rule: 'docker-logs-tail', reason: 'docker logs → --tail 200', note: 'token-plus limited docker logs to the last 200 lines; prefix TP_RAW=1 for all.', estimate: null };
  }
  if (words[0] === 'journalctl') {
    if (words.some((w) => /^(-n|--lines|-f|--follow|--since|--until|-b|-e)(=|$|\d)/.test(w))) return NOOP('journalctl already bounded');
    const raw = ctx.raws.slice();
    raw.splice(1, 0, '-n', '200', '--no-pager');
    return { words: raw, rule: 'journalctl-tail', reason: 'journalctl → -n 200', note: 'token-plus limited journalctl to 200 lines; prefix TP_RAW=1 for all.', estimate: null };
  }
  return null;
}

const RULES = [ruleGitStatus, ruleGitLog, ruleGitDiff, ruleFind, ruleGrep, ruleCat, ruleNpmInstall, rulePipInstall, rulePytest, ruleCargo, ruleGradle, ruleTree, ruleLogs];

/**
 * @param {string} command
 * @param {object} cfg effective config
 * @param {{cwd:string}} ctx
 * @returns {{changed:boolean, command?:string, rule?:string, reason?:string, note?:string, estimate?:object, skipped?:string}}
 */
function sanitizeCommand(command, cfg, ctx = {}) {
  if (cfg.mode === 'off' || !cfg.enableCommandRewriting) return NOOP('rewriting disabled');
  if (typeof command !== 'string' || !command.trim()) return NOOP('empty');
  if (command.length > 4000) return NOOP('command too long to analyse safely');
  const prot = isProtected(command, cfg);
  if (prot) return NOOP(prot);
  const sc = scan(command);
  if (!sc.ok) return NOOP(`not a simple command (${sc.reason})`);
  const last = sc.segments[sc.segments.length - 1];
  const { env, words } = splitEnv(last);
  if (env.some((t) => /^TP_RAW=/.test(t.raw))) return NOOP('TP_RAW escape hatch');
  if (!words.length) return NOOP('no command');
  let cwd = ctx.cwd || process.cwd();
  if (sc.segments.length === 2) cwd = path.resolve(cwd, sc.segments[0][1].value);
  const rctx = { words: words.map((t) => t.value), raws: words.map((t) => t.raw), cfg, cwd };
  for (const rule of RULES) {
    let r;
    try {
      r = rule(rctx);
    } catch (_) {
      r = NOOP('rule error');
    }
    if (!r) continue;
    if (r.changed === false) return r;
    if (!r.words) {
      return { changed: false, advisory: true, rule: r.rule, reason: r.reason, note: r.note, estimate: r.estimate };
    }
    const next = rebuild(sc, env, r.words);
    if (next === command) return NOOP('no-op rewrite');
    return { changed: true, command: next, rule: r.rule, reason: r.reason, note: r.note, estimate: r.estimate };
  }
  return NOOP('no rule matched');
}

module.exports = { sanitizeCommand, isProtected, matchProtectedPath, matchProtectedCommand, findGitDir, GENERATED_DIFF };
