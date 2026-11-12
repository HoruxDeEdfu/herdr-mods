#!/usr/bin/env bash
# Installs the Herdr mods (code-files, git-panel, git-tabs) and the main-code
# layout. Backs up anything it would replace.
#   ./install.sh              install and switch to the main-code layout
#   ./install.sh --no-switch  install without changing the active layout
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS=(code-files git-panel git-tabs)
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME/herdr-mods-backups/$STAMP"
SWITCH=1; [[ "${1:-}" == "--no-switch" ]] && SWITCH=0

if [[ ! -d "$HERDR" ]]; then
  echo "$HERDR not found. Open Herdr once so it creates its folder, then run this again." >&2
  exit 1
fi
mkdir -p "$HERDR/mods" "$HERDR/layouts"

backup() { # $1 = ruta existente
  mkdir -p "$BACKUP"
  cp -R "$1" "$BACKUP/"
  echo "  backup → $BACKUP/$(basename "$1")"
}

for m in "${MODS[@]}"; do
  dst="$HERDR/mods/$m"
  if [[ -d "$dst" ]]; then
    if diff -rq -x .drafts -x .dev.json -x .accounts.json -x .DS_Store "$SRC/mods/$m" "$dst" >/dev/null 2>&1; then
      echo "· $m is up to date"; continue
    fi
    backup "$dst"
  fi
  # Keeps the editor drafts (.drafts) and saved accounts (.accounts.json).
  rsync -a --delete --exclude .drafts --exclude .dev.json --exclude .accounts.json "$SRC/mods/$m/" "$dst/"
  echo "✓ $m installed"
done

layout="$HERDR/layouts/main-code.json"
if [[ -f "$layout" ]] && ! cmp -s "$SRC/layouts/main-code.json" "$layout"; then backup "$layout"; fi
cp "$SRC/layouts/main-code.json" "$layout"
echo "✓ main-code layout"

if command -v herdr-app >/dev/null; then
  for m in "${MODS[@]}"; do
    if out=$(herdr-app check "$HERDR/mods/$m" 2>&1); then echo "✓ check $m"; else echo "⚠ check $m:"; echo "$out"; fi
  done
  if [[ $SWITCH == 1 ]]; then
    herdr-app do layout.switch --name main-code >/dev/null 2>&1 \
      && echo "✓ active layout: main-code" \
      || echo "· Open Herdr and pick the main-code layout (or run: herdr-app do layout.switch --name main-code)"
  fi
else
  echo "· herdr-app is not on PATH: open Herdr and pick the main-code layout."
fi
[[ -d "$BACKUP" ]] && echo "To undo, copy back what is in $BACKUP."
echo "Done."
