# Changelog

All notable changes to token-plus are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-31

### Added
- **Command sanitizer** (PreToolUse/Bash): conservative rewrites for `git status`, unbounded `git log`, `git diff` with lockfile/generated changes, `find` listings, recursive `grep`, large `cat` (strict), `npm`/`pip` installs, `pytest`, `cargo`, `gradle`, `tree`, `docker logs`, `journalctl`. Built-in + configurable denylist, protected paths, `TP_RAW=1` escape hatch, and PostToolUse confirmation of whether each rewrite was actually applied.
- **Output compressor** (PostToolUse/Bash via `updatedToolOutput`): ANSI/progress cleanup, duplicate and repeated-warning folding, stack-trace folding, long-line truncation, head/tail windows with rescued error/failure/summary lines, explicit `[token-plus: …]` markers and a stats footer. Full original output saved to `.claude/token-plus/raw/` with rotation.
- **Read guard** (PreToolUse/Read): advisory notes for large, generated or repeatedly-read files; optional cap in strict mode.
- **Context hygiene**: static <120-word SessionStart rules (cache-stable) and Stop-hook compaction reminders shown to the user only, capped per session.
- Skills `targeted-reading` and `project-brief`; Haiku agents `quick-reader`, `quick-reviewer`, `doc-writer`.
- Commands `/token-plus:status`, `/token-plus:budget`, `/token-plus:audit`, `/token-plus:raw`, `/token-plus:init`, `/token-plus:reset`.
- Verified end-to-end with Claude Code headless runs: `git log` rewrite applied without a permission decision; `seq 1 20000` output compressed via `updatedToolOutput`.
- Test suite (unit + fixture-based integration), plugin layout validator, CI on Linux/macOS × Node 18/20/22.
