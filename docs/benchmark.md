# Benchmark plan: off vs normal vs strict

Goal: measure the **real** token impact of token-plus with Claude Code's own accounting, not the plugin's estimates, and check that correctness does not regress.

## Setup

- One fixed repo snapshot per scenario (pin the commit). Suggested: a mid-size TypeScript or Node repo with a slow, noisy test suite, plus a Python repo with pytest.
- Same Claude Code version, model, settings and MCP servers for all runs. Disable other plugins.
- A fresh session per run (`claude -p` headless, or interactive with `/clear` between runs). Prompt caching is enabled by default, so record cached and uncached input separately.
- Set the mode per run with `TOKEN_PLUS_MODE=off|normal|strict claude …`. `off` is the baseline, with the plugin loaded but inert, so the fixed skill and agent description overhead is the same in every arm. Also run one **uninstalled** baseline to measure that overhead.
- At least **5 runs per mode per task**, because model behaviour varies between runs.

## Tasks (scripted prompts)

| # | Task | Exercises |
|---|---|---|
| T1 | "Run the full test suite and fix the failing test." (one seeded failure) | test-output compression, `pytest -q`, re-reads |
| T2 | "Install dependencies and get the build passing." (one seeded type error) | install/build noise, warnings dedup |
| T3 | "Summarize what changed in the last 50 commits and in the working tree." (includes a lockfile change) | `git log` limit, `git diff` lockfile exclusion |
| T4 | "Find where `<symbol>` is defined and explain how it is used." | `grep -r`/`find` rewrites, read guard, targeted reading |
| T5 | "Debug this crash" with a seeded deep stack trace | stack-trace folding, raw-log fallback |
| T6 | A 25-turn scripted session that mixes T1–T4 | compaction reminders, context growth |

## Metrics

Primary, from Claude Code:
- Input tokens (uncached, cache-write, cache-read) and output tokens per run. Use `claude -p --output-format json` (the `usage` fields) or `/usage` at the end of an interactive run.
- `/context` snapshot at the end of each run: total context and its breakdown by category.

Secondary:
- **Task success**: the test passes, the build is green, or the answer matches the reference (graded by a fixed rubric or script).
- Number of tool calls, and wall-clock time.
- How many times Claude opened a raw log or used `TP_RAW=1`. A high count means compression is too aggressive for that task.
- `/token-plus:status` figures, reported **next to** the Claude Code numbers to check how well the estimate tracks reality (expect ±30%).

## Procedure

```bash
for mode in off normal strict; do
  for task in T1 T2 T3 T4 T5; do
    for run in 1 2 3 4 5; do
      git -C bench-repo reset --hard "$PINNED" && git -C bench-repo clean -fdx
      (cd bench-repo && TOKEN_PLUS_MODE=$mode claude -p "$(cat prompts/$task.txt)" \
         --output-format json > "../results/$mode-$task-$run.json")
      cp bench-repo/.claude/token-plus/events.jsonl "results/$mode-$task-$run.events.jsonl" 2>/dev/null || true
    done
  done
done
```

## Reporting

For each task, report the median and IQR of total input tokens (cached and uncached separately) and output tokens per mode, the success rate per mode, and the percentage change against `off`. A change counts as a win only if:

1. The median total tokens drop by at least 10%, **and**
2. The success rate does not drop (no more than 1 failure in 5 compared with baseline).

Any task where strict mode lowers success is a signal to loosen that rule or threshold, not to ship it.

## Expected shape (hypothesis, to be verified)

- Large savings on T1, T2 and T5, where output is noisy. Modest savings on T3. Little or none on T4, which is dominated by reads that the guard only advises on.
- Cache-read tokens should be **unchanged** between arms at session start, because the SessionStart text is static. Any difference there points to a cache-stability bug.
