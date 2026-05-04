#!/usr/bin/env bash
# Idempotently link tracked git hooks into .git/hooks/.
# Run automatically via package.json `prepare` after `npm install`.
set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  exit 0
fi

SRC_DIR="$ROOT/scripts/git-hooks"
DST_DIR="$ROOT/.git/hooks"

if [ ! -d "$SRC_DIR" ]; then
  exit 0
fi

mkdir -p "$DST_DIR"

for src in "$SRC_DIR"/*; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  dst="$DST_DIR/$name"
  ln -sf "$src" "$dst"
  chmod +x "$src"
  echo "[install-hooks] linked $dst → $src"
done
