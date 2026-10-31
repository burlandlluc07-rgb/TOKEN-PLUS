#!/bin/sh
# Build an upload-ready plugin zip: one top-level token-plus/ folder containing
# .claude-plugin/plugin.json (the layout the Claude web app plugin uploader expects).
# Usage: scripts/build-zip.sh [output-dir]   (default: dist/)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-"$ROOT/dist"}
VERSION=$(node -p "require('$ROOT/plugins/token-plus/.claude-plugin/plugin.json').version")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/token-plus" "$OUT"
cp -R "$ROOT/plugins/token-plus/." "$STAGE/token-plus/"
cp "$ROOT/README.md" "$ROOT/LICENSE" "$ROOT/CHANGELOG.md" "$STAGE/token-plus/"
ZIP="$OUT/token-plus-$VERSION.zip"
rm -f "$ZIP"
(cd "$STAGE" && zip -qrX "$ZIP" token-plus)
# Sanity check: the manifest must be at token-plus/.claude-plugin/plugin.json
unzip -l "$ZIP" | grep -q ' token-plus/.claude-plugin/plugin.json$' || { echo "manifest missing from zip" >&2; exit 1; }
echo "$ZIP"
