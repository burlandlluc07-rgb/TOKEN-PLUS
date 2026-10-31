---
description: List the most recent full (uncompressed) outputs that token-plus saved
argument-hint: "[count]"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" raw $ARGUMENTS`

Show the list above. Only read a raw log if the user asks, and then read just the needed line range.
