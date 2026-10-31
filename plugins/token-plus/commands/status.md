---
description: Show token-plus telemetry (rewrites, compressions, estimated savings, mode, hook failures)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" status`

Relay the status above to the user as-is. Do not run further tools.
