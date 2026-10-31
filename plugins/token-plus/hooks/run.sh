#!/bin/sh
# token-plus hook launcher.
# Degrades gracefully: if Node.js is missing or the hook crashes, print nothing and
# exit 0 so Claude Code proceeds with the original, unmodified tool call/output.
# Set TOKEN_PLUS_DISABLE=1 in the environment to turn every hook into a no-op.
[ "${TOKEN_PLUS_DISABLE:-}" = "1" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0
node "$(dirname "$0")/../scripts/hook.js" "$@" 2>/dev/null
exit 0
