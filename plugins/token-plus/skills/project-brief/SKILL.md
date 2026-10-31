---
name: project-brief
description: Create or refresh a compact (<150 lines) project brief at .claude/token-plus/project-brief.md so future sessions can skip exploratory reads. Use when the user asks for a project brief/summary/onboarding notes, or after major structural changes.
---

# Project brief

Produce a small, high-signal brief that replaces repeated exploration. It is **not** loaded automatically; it is read on demand (or at session start only if the user sets `"loadProjectBrief": true` in `.claude/token-plus.json`).

## Gather cheaply
- `git ls-files | head -200` or `Glob` for top-level structure; `ls` key directories only.
- Read manifests (`package.json` scripts, `pyproject.toml`, `Makefile`, `Cargo.toml`, CI workflow) — just the relevant sections.
- Grep for entrypoints (`main(`, `createServer`, `app =`, `if __name__`), not whole files.
- If `.claude/token-plus/project-brief.md` exists, read it first and update only stale sections.
- For a large repo, delegate the survey to the `token-plus:quick-reader` agent and use its summary.

## Write `.claude/token-plus/project-brief.md` (hard limit 150 lines)
```
# Project brief — <name>   (updated YYYY-MM-DD)
## Architecture        (5-12 bullets: components, data flow, key deps)
## Important directories (path — purpose, one line each)
## Build / test / run  (exact commands; the fastest targeted test command)
## Conventions         (style, naming, error handling, commit/PR rules)
## Known pitfalls      (gotchas, flaky tests, generated files not to edit)
## Current task state  (goal, done, in progress, next steps, open questions)
```
Rules: facts only, no prose padding, no code blocks longer than 5 lines, paths not file contents. Count lines before saving; trim lowest-value bullets if over 150.

## After writing
Tell the user the path and line count. Suggest adding a one-line pointer in CLAUDE.md (e.g. "Project brief: .claude/token-plus/project-brief.md — read when you need orientation") instead of pasting the brief into CLAUDE.md.
