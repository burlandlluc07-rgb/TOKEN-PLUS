'use strict';
// Configuration loading for token-plus.
// Precedence (lowest -> highest):
//   built-in defaults < ~/.claude/token-plus.json < <project>/.claude/token-plus.json
//   < mode override in state file (/token-plus:budget) < TOKEN_PLUS_MODE env var.
// Any read/parse error falls back to defaults; config never throws.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = Object.freeze({
  mode: 'normal', // off | normal | strict
  maxToolOutputLines: 150,
  maxToolOutputChars: 6000,
  headLines: 50,
  tailLines: 75,
  minCompressChars: 2000, // outputs smaller than this always pass through untouched
  maxLineChars: 2000, // single lines longer than this are middle-truncated when compressing
  maxImportantLines: 60, // max error/failure lines rescued from the elided middle
  compactReminderTurns: 12,
  maxCompactRemindersPerSession: 3,
  compactReminderChars: 600000, // transcript size that also triggers a reminder (~150k tokens est.)
  largeFileWarningLines: 1000,
  readGuardMode: 'advise', // advise | cap   (cap only applies in strict mode)
  enableCommandRewriting: true,
  enableOutputCompression: true,
  enableReadGuard: true,
  enableSubagentRouting: false,
  loadProjectBrief: false,
  rewritePermission: 'default', // default | ask | allow  (see README "Permissions")
  saveRawOutput: true,
  rawOutputRetention: 30,
  gitLogLimit: 30,
  findMaxDepth: 6,
  tokensPerChar: 0.25, // conservative chars/4 heuristic
  protectedCommands: ['rm', 'mv', 'git push', 'git reset', 'git clean', 'deploy'],
  protectedPaths: ['.env', '.env.*', 'secrets', 'credentials', '*.pem', '*.key'],
});

// Built-in protections that the user cannot remove (they can only add more).
const BUILTIN_PROTECTED_COMMANDS = [
  'rm', 'mv', 'cp', 'dd', 'shred', 'truncate', 'chmod', 'chown', 'sudo', 'su',
  'git push', 'git reset', 'git checkout', 'git switch', 'git restore', 'git clean',
  'git rebase', 'git merge', 'git commit', 'git stash', 'git branch -d', 'git branch -D',
  'git tag -d', 'git filter-branch', 'git gc', 'git prune',
  'deploy', 'migrate', 'migration', 'terraform', 'kubectl', 'helm', 'pulumi',
  'docker push', 'npm publish', 'yarn publish', 'pnpm publish', 'cargo publish', 'twine',
  'db:', 'dropdb', 'psql', 'mysql', 'mongo', 'redis-cli', 'sqlite3',
];

const STRICT_OVERRIDES = {
  maxToolOutputLines: 80,
  maxToolOutputChars: 4000,
  headLines: 30,
  tailLines: 40,
  maxImportantLines: 30,
  gitLogLimit: 15,
  findMaxDepth: 4,
  compactReminderTurns: 8,
};

const VALID_MODES = ['off', 'normal', 'strict'];

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
}

function userConfigPath() {
  const home = process.env.TOKEN_PLUS_HOME || os.homedir();
  return path.join(home, '.claude', 'token-plus.json');
}

function projectConfigPath(dir) {
  return path.join(dir, '.claude', 'token-plus.json');
}

// Validate and coerce a partial config against DEFAULTS types. Returns {config, warnings}.
function sanitize(partial, source) {
  const out = {};
  const warnings = [];
  if (!partial) return { config: out, warnings };
  for (const [k, v] of Object.entries(partial)) {
    if (k.startsWith('$') || k.startsWith('//') || k === 'comment') continue;
    if (!(k in DEFAULTS)) {
      warnings.push(`${source}: unknown key "${k}" ignored`);
      continue;
    }
    const d = DEFAULTS[k];
    if (Array.isArray(d)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
      else warnings.push(`${source}: "${k}" must be an array of strings`);
    } else if (typeof d === 'number') {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
      else warnings.push(`${source}: "${k}" must be a non-negative number`);
    } else if (typeof d === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
      else warnings.push(`${source}: "${k}" must be true/false`);
    } else if (k === 'mode') {
      if (VALID_MODES.includes(v)) out[k] = v;
      else warnings.push(`${source}: "mode" must be one of ${VALID_MODES.join('|')}`);
    } else if (k === 'readGuardMode') {
      if (v === 'advise' || v === 'cap') out[k] = v;
      else warnings.push(`${source}: "readGuardMode" must be advise|cap`);
    } else if (k === 'rewritePermission') {
      if (['default', 'ask', 'allow'].includes(v)) out[k] = v;
      else warnings.push(`${source}: "rewritePermission" must be default|ask|allow`);
    } else if (typeof v === typeof d) {
      out[k] = v;
    }
  }
  return { config: out, warnings };
}

/**
 * Load the effective configuration.
 * @param {object} [input] hook input (uses .cwd)
 * @param {object} [opts] { stateMode } mode override from the state file
 */
function loadConfig(input, opts = {}) {
  const dir = projectDir(input);
  const u = sanitize(readJson(userConfigPath()), '~/.claude/token-plus.json');
  const p = sanitize(readJson(projectConfigPath(dir)), '.claude/token-plus.json');
  const cfg = Object.assign({}, DEFAULTS, u.config, p.config);
  const warnings = [...u.warnings, ...p.warnings];

  if (opts.stateMode && VALID_MODES.includes(opts.stateMode)) cfg.mode = opts.stateMode;
  const envMode = process.env.TOKEN_PLUS_MODE;
  if (envMode && VALID_MODES.includes(envMode)) cfg.mode = envMode;

  if (cfg.mode === 'strict') {
    for (const [k, v] of Object.entries(STRICT_OVERRIDES)) {
      // strict only ever tightens; never loosens a stricter user value
      cfg[k] = Math.min(cfg[k], v);
    }
    if (!(p.config.readGuardMode || u.config.readGuardMode)) cfg.readGuardMode = 'cap';
  } else if (cfg.readGuardMode === 'cap') {
    cfg.readGuardMode = 'advise'; // capping is a strict-mode only behaviour
  }

  // Protections are additive.
  cfg.protectedCommands = Array.from(new Set([...BUILTIN_PROTECTED_COMMANDS, ...cfg.protectedCommands]));
  cfg.protectedPaths = Array.from(new Set([...DEFAULTS.protectedPaths, ...cfg.protectedPaths]));
  cfg.headLines = Math.max(1, Math.floor(cfg.headLines));
  cfg.tailLines = Math.max(1, Math.floor(cfg.tailLines));
  cfg._projectDir = dir;
  cfg._warnings = warnings;
  return cfg;
}

module.exports = {
  DEFAULTS,
  STRICT_OVERRIDES,
  BUILTIN_PROTECTED_COMMANDS,
  VALID_MODES,
  loadConfig,
  sanitize,
  projectDir,
  projectConfigPath,
  userConfigPath,
};
