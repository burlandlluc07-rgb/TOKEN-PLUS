---
name: targeted-reading
description: Read code and docs with minimal tokens - locate first, then read only the needed lines. Use before exploring an unfamiliar codebase, opening a large file, or when token-plus flags a large/repeated read.
---

# Targeted reading

Goal: get the facts you need while pulling the fewest lines into context.

## Order of operations
1. **Locate, don't browse.** Start with `Grep` (narrow regex + `glob`/`path`), `Glob` (specific patterns like `src/**/*auth*.ts`), or an LSP/symbol tool if available. Use `output_mode: "files_with_matches"` or `count` before `content`.
2. **Read a window, not a file.** For files over ~300 lines, `Read` with `offset`/`limit` around the match (e.g. 40-120 lines). Expand only if the window is insufficient.
3. **Follow references deliberately.** Jump to a definition with a targeted Grep (`function name\b`, `class Name`, `def name`, `name =`), not by reading neighbouring files.
4. **Read once.** Keep notes of what you learned (path:line + one-line summary). Do not re-read an unchanged file; re-read only the changed range after an edit.

## Avoid unless the task explicitly needs them
- Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, `go.sum`)
- Generated/minified/bundled output (`dist/`, `build/`, `*.min.js`, `*.map`, `coverage/`, snapshots)
- Vendored deps (`node_modules/`, `vendor/`, `.venv/`), binaries, large data (CSV/JSON dumps, fixtures)
For data files, inspect structure with `head -n 20` or a Grep for the key you need.

## Reporting
- Summarize; cite `path:line` instead of quoting. Quote at most the few lines that prove a point.
- Never paste whole files or long tool output back to the user.

## Bash equivalents (when a tool is unavailable)
- `rg -n --glob '*.py' 'pattern' src/` instead of `grep -r`
- `sed -n '120,200p' file` instead of `cat file`
- `git log --oneline -n 20 -- path`, `git diff --stat` then `git diff -- path`
- Prefix `TP_RAW=1` only when you truly need unfiltered output.
