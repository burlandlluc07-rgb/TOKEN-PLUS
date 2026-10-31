# token-plus

A Claude Code plugin that cuts token usage **by stopping waste before it enters context**, without hiding information Claude needs, without taking control away from you, and without breaking prompt caching.

- **Prevent first.** Safe rewrites of a few well-known token-hungry commands (`git log`, `git status`, `find`, recursive `grep`, …).
- **Compress as a fallback.** Oversized Bash output is trimmed to the parts that matter (errors, failures, summaries, head and tail). Every cut is marked, and the full output is saved locally, so nothing is lost for good.
- **Keep context clean.** A short, static set of rules at session start, an advisory guard on file reads, and compaction reminders that only you see.
- **Measure honestly.** Measured savings and heuristic estimates are reported separately and labelled as estimates. They are never billing figures.

> Status: 0.1.0. Requires Claude Code with plugin support and Node.js ≥ 18 on `PATH`. If Node is missing, the hooks pass everything through unchanged.

---

## Contents

- [Install](#install)
- [Verify it is working](#verify-it-is-working)
- [What it does](#what-it-does)
- [Commands](#commands)
- [Configuration](#configuration)
- [Modes](#modes-off--normal--strict)
- [Permissions and safety](#permissions-and-safety)
- [Examples](#examples)
- [Limitations](#limitations)
- [Privacy](#privacy)
- [Uninstall](#uninstall)
- [Development](#development)

---

## Install

From GitHub (this repository is a plugin marketplace):

```text
/plugin marketplace add burlandlluc07-rgb/TOKEN-PLUS
/plugin install token-plus@token-plus
```

Restart Claude Code (or run `/reload-plugins` if your version has it) so the hooks load.

From a local checkout, for development or to try it out:

```bash
git clone https://github.com/burlandlluc07-rgb/TOKEN-PLUS
claude --plugin-dir ./TOKEN-PLUS/plugins/token-plus
```

Optional: write a project config with the documented defaults:

```text
/token-plus:init
```

Add the runtime data to your project's `.gitignore`:

```gitignore
.claude/token-plus/
.claude/token-plus-state.json
```

## Verify it is working

| Check | What you should see |
|---|---|
| `/hooks` | `SessionStart`, `PreToolUse` (matchers `Bash`, `Read`), `PostToolUse` (`Bash`) and `Stop` entries whose source is the **token-plus** plugin, each running `sh ".../hooks/run.sh" <name>`. |
| `claude --debug` | For each Bash call, debug lines show the token-plus hook running and its JSON output, e.g. `updatedInput` for `git log` or `updatedToolOutput` for large output. Hook errors appear here too. |
| Ask Claude to run `git log` in a repo with more than 30 commits | The command runs as `git log --oneline -n 30`. `/token-plus:status` shows `Commands rewritten … 1 / 1` (proposed / confirmed applied). |
| Ask Claude to run a noisy command, such as `npm install` or a verbose test suite | The output ends with `[token-plus: elided … | original N lines … → kept M lines | ~T tokens saved (est.) | mode=… | full output: .claude/token-plus/raw/…log]`. |
| `/context` | The token-plus SessionStart rules are a small fixed block (under 120 words). The skill and agent descriptions add a few hundred tokens. Compare against a session with the plugin disabled. |
| `/usage` (or `/cost` on older versions) | The authoritative token and cost numbers. Use these, not `/token-plus:status`, to judge real savings. See [docs/benchmark.md](docs/benchmark.md). |
| `/token-plus:status` | Counters for turns, rewrites, compressions, estimated savings, reminders, current mode and hook failures. |

If a rewrite shows as proposed but not applied, your Claude Code version ignored `updatedInput` without a permission decision. Set `"rewritePermission": "ask"` and read [Permissions and safety](#permissions-and-safety).

## What it does

| Component | Hook / type | Default | What it does |
|---|---|---|---|
| Command sanitizer | `PreToolUse` · Bash | on | Rewrites only allowlisted, read-only command shapes. See the [rule table](#command-rewrite-rules). |
| Output compressor | `PostToolUse` · Bash | on | Above 150 lines or 6,000 chars, replaces what Claude sees with a compressed version (`updatedToolOutput`) and saves the original to a raw log. |
| Read guard | `PreToolUse` · Read | advisory | Adds a one-line note when a file is large, generated or vendored, or was already read unchanged. In strict mode it caps unranged reads of large files. It never blocks a read. |
| Session rules | `SessionStart` | on | Injects a fixed block of token-discipline rules (under 120 words) at the start of the conversation. |
| Compaction reminders | `Stop` | every 12 turns, max 3 | Shows **you** a `/compact <focus>` suggestion that names the changed files. It never runs `/compact` or `/clear` itself. |
| `token-plus:targeted-reading` | skill | on demand | How to locate code first and read only the lines you need. |
| `token-plus:project-brief` | skill | on demand | Generates or refreshes a brief of under 150 lines at `.claude/token-plus/project-brief.md`. The brief is not auto-loaded unless you enable it. |
| `quick-reader`, `quick-reviewer`, `doc-writer` | agents (Haiku) | explicit use only | Cheap summarising, small-diff review and localized docs. Each returns a short structured result. |
| `/token-plus:*` | commands | — | `status`, `budget`, `audit`, `raw`, `init`, `reset` |

### Command rewrite rules

A rule fires only when the whole command is one simple command (optionally `cd dir && cmd`) with no pipes, redirects, `$…` expansion, subshells, heredocs, comments, `;` or `&`. It also never fires when the command touches a protected command or path, or is prefixed with `TP_RAW=1`. Every rule backs off when it sees a flag it does not understand.

| Command | Rewrite | Backs off when |
|---|---|---|
| `git status [paths]` | `--short --branch` | any flag given; a merge, rebase, cherry-pick, revert or bisect is in progress (the long form explains it); not in a repo |
| `git log` | `--oneline -n 30` (strict: 15); only `-n` if a format such as `-p` or `--format` is given | already limited; search or range flags (`--grep`, `-S`, `--author`, `A..B`, `--all`, `--reverse`, `-- path`); history is shorter than the limit; unknown flags |
| `git diff [rev]` | excludes changed lockfiles and generated files (`package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`, `*.min.js`, `*.map`, snapshots, …) by exact path from the repo root; strict also adds `--unified=1` | paths or `--` given; `--stat`, `--name-only`, `--no-index` and similar; an argument that could be a file; no generated files changed (normal mode) |
| `find <dir> [-type f\|d]` (listings only) | `-maxdepth 6` (strict: 4) plus skip `node_modules` and `.git` | any search predicate (`-name`, `-newer`, …), action (`-exec`, `-delete`), operator or explicit depth. Searches are never depth-limited, because a cap could make Claude wrongly conclude a file does not exist. |
| `grep -r …` | `--exclude-dir=` for the vendored or build dirs that actually exist (`.git`, `node_modules`, `.venv`, `dist`, `build`, `target`, …) | `--include` or `--exclude` given; searching inside one of those dirs; unknown long options |
| `cat <large file>` | normal: unchanged plus an advisory note; strict: `head -n 80 -- file && echo '[token-plus: showed lines 1-80 of N …]'` | small file; multiple files; flags |
| `npm install/ci/i/add` | `--no-fund` (never `--no-audit`, because security warnings stay visible) | output flags given |
| `pip install` | `--progress-bar=off --disable-pip-version-check` | `-v` or progress flags given |
| `pytest` | `-q` (strict also `--tb=short`) | any verbosity flag given |
| `cargo build/test/check/clippy` | `-q` (warnings and errors still print) | verbosity or `--message-format` given |
| `gradle` / `./gradlew` | `--console=plain` | console flag given |
| `tree` | `-L 3` (strict: 2) and skip vendored dirs | `-L` or `-I` given |
| `docker logs`, `journalctl` | last 200 lines | already bounded or following |

Never rewritten, built in and not removable: `rm`, `mv`, `cp`, `dd`, `chmod`, `sudo`, `git push`, `git reset`, `git checkout`, `git switch`, `git restore`, `git clean`, `git rebase`, `git merge`, `git commit`, `git stash`, branch and tag deletes, `deploy`, `migrate`, `terraform`, `kubectl`, `helm`, `pulumi`, publish commands, and database CLIs. Add your own with `protectedCommands`.

When Claude Code applies a rewrite, Claude also gets one short line saying what changed and how to bypass it (`TP_RAW=1`), so the change is visible rather than silent.

### Output compression

The compressor runs only when output is at least `minCompressChars` (2,000) **and** over `maxToolOutputLines` (150) or `maxToolOutputChars` (6,000). It works in this order:

1. Strips ANSI codes and resolves carriage-return progress redraws.
2. Replaces binary output with a one-line notice. The bytes are kept in the raw log.
3. Removes noise based on the type of command. It detects test, build, install, git, stack-trace and generic output from the command and the content. For example, it drops progress bars, `Compiling foo v1.2`, `Requirement already satisfied`, `npm http fetch` lines, and PASS lines in test runs. It never drops a line that matches an error, failure, warning, vulnerability or summary pattern. Generic output, such as `cat file`, only loses obvious progress bars.
4. Collapses repeated identical lines (`… [token-plus: ×3000 identical lines]`). In build and install logs it also folds repeated warnings, keeping the first 2 of each pattern.
5. Folds long stack-frame runs. It keeps the first 3 and last 3 frames plus the first non-framework frames, together with the exception line and every `Caused by:` line.
6. Middle-truncates very long lines (minified JSON, for example) without splitting Unicode characters.
7. Keeps the first `headLines` and last `tailLines` lines. From the middle it keeps up to `maxImportantLines` error, failure and summary lines with one line of context, and marks each gap `[token-plus: elided N lines]`.
8. Adds a footer: `[token-plus: elided … | original N lines/C chars → kept M lines | ~T tokens saved (est.) | mode=test | full output: .claude/token-plus/raw/<file>.log]`.

If compression would save less than 10%, the output passes through untouched. `stdout` and `stderr` are compressed separately, and `interrupted` and `isImage` keep their values.

### Context hygiene

- **SessionStart** adds the same bytes every session. That keeps the cached prompt prefix stable. Nothing dynamic (counters, dates, git state) is ever injected there.
- Per-call notes from the sanitizer and read guard are short `additionalContext` strings that attach to the current tool result. They are appended at the end of the conversation, never inserted into the cached prefix.
- **Stop** reminders use `systemMessage`. You see them in the UI, but they **do not enter Claude's context**, so they cost zero tokens. Reminders are capped (`maxCompactRemindersPerSession`) and spaced (`compactReminderTurns`). A one-time reminder also fires when the transcript passes `compactReminderChars`. A `/compact` (SessionStart `source=compact`) restarts the interval.

## Commands

| Command | Purpose |
|---|---|
| `/token-plus:status` | Turns monitored, rewrites (proposed and confirmed applied), outputs compressed, measured chars and lines removed, **estimated** tokens saved, heuristic lines avoided by rewrites, read-guard notes, reminders, mode, hook failures |
| `/token-plus:budget off\|normal\|strict` | Change aggressiveness for this project. It takes effect on the next tool call and is stored in `.claude/token-plus-state.json`. |
| `/token-plus:audit` | Read-only report: configured MCP servers and whether recent transcripts used them, CLAUDE.md sizes, enabled plugins and skills, heaviest recent commands, recommendations. It **never modifies** MCP or settings. |
| `/token-plus:raw [n]` | List the latest full outputs saved before compression |
| `/token-plus:init` | Write `.claude/token-plus.json` with the defaults. It never overwrites an existing file. |
| `/token-plus:reset` | Clear telemetry counters. Mode, config and raw logs are kept. |

## Configuration

Config is merged in this order, each layer overriding the one before: built-in defaults, then `~/.claude/token-plus.json`, then `<project>/.claude/token-plus.json`, then the `/token-plus:budget` mode, then the `TOKEN_PLUS_MODE` env var. Unknown keys and invalid values are ignored, and a warning is shown to you at session start.

```json
{
  "mode": "normal",
  "maxToolOutputLines": 150,
  "maxToolOutputChars": 6000,
  "headLines": 50,
  "tailLines": 75,
  "minCompressChars": 2000,
  "maxLineChars": 2000,
  "maxImportantLines": 60,
  "compactReminderTurns": 12,
  "maxCompactRemindersPerSession": 3,
  "compactReminderChars": 600000,
  "largeFileWarningLines": 1000,
  "readGuardMode": "advise",
  "enableCommandRewriting": true,
  "enableOutputCompression": true,
  "enableReadGuard": true,
  "enableSubagentRouting": false,
  "loadProjectBrief": false,
  "rewritePermission": "default",
  "saveRawOutput": true,
  "rawOutputRetention": 30,
  "gitLogLimit": 30,
  "findMaxDepth": 6,
  "tokensPerChar": 0.25,
  "protectedCommands": ["rm", "mv", "git push", "git reset", "git clean", "deploy"],
  "protectedPaths": [".env", ".env.*", "secrets", "credentials", "*.pem", "*.key"]
}
```

| Key | Meaning |
|---|---|
| `mode` | `off` · `normal` · `strict` (see below) |
| `maxToolOutputLines` / `maxToolOutputChars` | Compression triggers when output exceeds either one |
| `headLines` / `tailLines` | Lines kept verbatim from the start and end |
| `minCompressChars` | Output smaller than this is never touched |
| `maxLineChars` | Longer single lines are middle-truncated |
| `maxImportantLines` | Budget of error, failure and summary lines rescued from the elided middle |
| `compactReminderTurns` / `maxCompactRemindersPerSession` / `compactReminderChars` | Reminder interval, cap per session, and transcript-size trigger (bytes) |
| `largeFileWarningLines` | Read guard and `cat` threshold |
| `readGuardMode` | `advise` (default) or `cap`. `cap` only applies in strict mode, which uses it by default. |
| `enableCommandRewriting` / `enableOutputCompression` / `enableReadGuard` | Turn individual features on or off |
| `enableSubagentRouting` | Adds one line at session start telling Claude the Haiku helpers exist. Off by default, so the agents are only used when you ask. |
| `loadProjectBrief` | Inject `.claude/token-plus/project-brief.md` (capped at 150 lines) at session start |
| `rewritePermission` | How rewrites interact with permission prompts. See below. |
| `saveRawOutput` / `rawOutputRetention` | Keep the full original of compressed outputs, and how many files to retain |
| `gitLogLimit` / `findMaxDepth` | Rewrite limits (strict mode clamps them to 15 and 4) |
| `tokensPerChar` | Estimation heuristic (chars × 0.25, which is chars/4) |
| `protectedCommands` / `protectedPaths` | Added to the built-in denylists, never replacing them. Commands that touch a protected path are never rewritten, and their output is never compressed or saved to disk. |

Environment switches: `TOKEN_PLUS_MODE=off|normal|strict` overrides the mode. `TOKEN_PLUS_DISABLE=1` turns every hook into a no-op.

## Modes: off / normal / strict

| | off | normal (default) | strict |
|---|---|---|---|
| Command rewrites | none | safe set | safe set, tighter limits (`git log -n 15`, `find -maxdepth 4`, `diff -U1`, large `cat` → `head`, `pytest --tb=short`) |
| Compression threshold | none | 150 lines / 6,000 chars, head 50, tail 75 | 80 lines / 4,000 chars, head 30, tail 40 |
| Read guard | none | advisory | caps unranged reads above `largeFileWarningLines` (1,000) with `limit`; Claude is told how to read more |
| Session rules | none | yes | yes |
| Reminders | none (turns still counted) | every 12 turns | every 8 turns |

Strict only ever tightens. If your config is already stricter than the strict preset, your value is kept.

## Permissions and safety

Claude Code applies a PreToolUse hook's `updatedInput` to the tool call. A hook can also return a `permissionDecision`, but `"allow"` **skips your permission prompt**, which a token optimizer should not do on your behalf. token-plus therefore defaults to `rewritePermission: "default"`. It returns `updatedInput` without any decision, so your normal permission rules and prompts still apply.

To check whether your Claude Code version honours this, `PostToolUse` compares the command that actually ran with the proposed rewrite, and `/token-plus:status` reports `proposed / confirmed applied`. If rewrites are never applied:

- `"rewritePermission": "ask"` shows you the rewritten command in a permission prompt (safest).
- `"rewritePermission": "allow"` auto-approves rewritten commands. Only use this if you are comfortable auto-approving the read-only commands in the rule table. Every rule only produces read-only commands, but this still bypasses your prompt for them.

Other guarantees:
- Hooks never block a tool call (`deny` is never used), and Read is never blocked.
- Any hook failure (no Node, a crash, malformed input, a timeout) results in **no output and exit 0**. Claude Code then proceeds with the original command and output. Failures that reach the handler are logged and counted in `/token-plus:status`.
- Compression is reversible: the full output is in `.claude/token-plus/raw/`, and the footer names the file.
- `TP_RAW=1 <command>` bypasses both rewriting and compression for one command.

## Examples

```text
> show me the recent history
  Bash(git log)                       → runs: git log --oneline -n 30
  + note to Claude: "token-plus limited git log to 30 commits (--oneline). Use explicit -n/--format, or prefix TP_RAW=1, for more."

> run the tests
  Bash(pytest)                        → runs: pytest -q
  326-line output → 30 lines:
    FAILED tests/test_mod4.py::test_case_137 - assert 9 == 10
    FAILED tests/test_mod8.py::test_case_241 - json.decoder.JSONDecodeError
    ======================== 2 failed, 298 passed in 4.21s =========================
    [token-plus: elided 298 progress/noise lines | original 327 lines/18,058 chars → kept 29 lines | ~4,219 tokens saved (est.) | mode=test | full output: .claude/token-plus/raw/2026-…_toolu_01….log]

> what changed?
  Bash(git diff)                      → runs: git diff -- :/ ':(top,exclude)package-lock.json'
  + note: "token-plus excluded lockfile/generated diffs (package-lock.json; ~4,812 lines). View with: TP_RAW=1 git diff -- <file>."

> Read src/huge_module.py             (4,000 lines, no range)
  + note: "token-plus: src/huge_module.py has 4000 lines (~32,000 tokens est.). Prefer Grep to locate the symbol, then Read with offset/limit."

after 12 turns (shown to you only):
  token-plus: 12 turns this session, transcript ~410 KB (≈104,960 tokens upper-bound est.). If you are continuing the same task,
  consider: /compact Preserve current task, changed files (src/api.ts, tests/api.test.ts), failing tests, commands run, and next steps.
  If you are switching to an unrelated task, /clear is cheaper. (reminder 1/3; …)
```

## Limitations

- **Estimates are estimates.** "Tokens saved" means characters removed × `tokensPerChar`. Real tokenization differs, especially for code and non-English text. Savings from rewrites are counterfactual: we cannot know what the original command would have printed, so they are shown separately as heuristic, or measured where cheap (lockfile `numstat`, file size). Use `/usage` and `/context` for ground truth.
- **Compression is lossy in what Claude sees.** The heuristics keep errors, failures and summaries, but a rare important line in the middle of a huge non-error output can still be elided. The raw log keeps everything, and Claude is told where it is.
- The raw log holds what Claude Code hands to the hook. Claude Code truncates very long Bash output itself (around 30,000 characters) before hooks see it, so for huge outputs the raw log is that truncated version. Re-run with narrower arguments, or redirect to a file, when you need everything.
- Only **Bash output** is compressed. Output from Read, Grep, WebFetch and MCP tools is not modified, though the read guard advises on large reads.
- Rewriting depends on Claude Code honouring `updatedInput` (check with `/token-plus:status`, see [Permissions](#permissions-and-safety)). Older versions without `updatedToolOutput` for built-in tools ignore the compressor's replacement. In that case nothing breaks, but nothing is saved either.
- The shell scanner is intentionally conservative. Anything with pipes, `$VAR`, redirects, subshells or multiple statements is never rewritten, even when a rewrite would be safe. Those outputs are still compressed.
- `grep -r` is not converted to `rg`, because ripgrep honours `.gitignore` and has different regex syntax, which changes results. The session rules steer Claude to the built-in Grep tool instead.
- Turn counting relies on the `Stop` hook, so turns that end in errors may not be counted. The transcript size is a JSONL byte count, which is an upper bound on context.
- MCP usage detection in `/token-plus:audit` scans the 20 most recent transcripts of this project (at most the last 8 MB each). Connector, plugin and managed servers that are not in `~/.claude.json` or `.mcp.json` are only listed if they were used.
- Requires `sh` and Node ≥ 18. On native Windows without a POSIX shell the hooks will not run. Use WSL or Git Bash.
- Skill and agent descriptions add a small, fixed amount of context (a few hundred tokens) to every session. `/token-plus:audit` and `/context` show it.

## Privacy

- Everything runs locally with **no network access**. No telemetry leaves your machine.
- Data is written only inside your project: `.claude/token-plus-state.json` (mode and turn counters) and `.claude/token-plus/` (events log, raw outputs, per-session read history, optional brief).
- Raw logs contain full command output, which may include anything your commands print. They are created with `0600` permissions and rotated (default 30 files). Commands that touch protected paths (`.env`, `*.pem`, `secrets`, …) are never saved. Add the paths above to `.gitignore`, and delete `.claude/token-plus/raw/` at any time.
- `/token-plus:audit` reads `~/.claude.json`, settings files, CLAUDE.md files and recent transcripts locally to produce its report. It writes nothing.

## Uninstall

```text
/plugin uninstall token-plus@token-plus
/plugin marketplace remove token-plus
```

Then remove the local data from each project where you used it:

```bash
rm -rf .claude/token-plus .claude/token-plus-state.json .claude/token-plus.json
```

To pause without uninstalling, run `/token-plus:budget off`, or set `TOKEN_PLUS_DISABLE=1`.

## Development

```text
.
├── .claude-plugin/marketplace.json     # marketplace entry → plugins/token-plus
├── plugins/token-plus/
│   ├── .claude-plugin/plugin.json      # plugin manifest
│   ├── hooks/hooks.json, run.sh        # hook registrations + POSIX launcher (graceful fallback)
│   ├── scripts/hook.js, cli.js         # hook entrypoint; status/budget/audit CLI
│   ├── lib/                            # config, state, shell scanner, sanitizer, compressor, handlers
│   ├── skills/, agents/, commands/
│   └── config/token-plus.default.json
├── tests/                              # node:test unit + integration tests, fixtures/
├── scripts/validate-plugin.js          # static layout validation (CI)
└── docs/benchmark.md
```

```bash
npm test                 # unit + integration tests (no dependencies)
npm run validate         # manifest / hooks / frontmatter checks
claude --plugin-dir ./plugins/token-plus --debug
```

The code has no runtime dependencies (plain Node.js CommonJS). Hooks are tested by piping JSON into the real `run.sh` launcher, exactly as Claude Code does.

## License

MIT — see [LICENSE](LICENSE).
